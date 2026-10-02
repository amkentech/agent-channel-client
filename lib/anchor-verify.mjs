// External anchors for the ledger head: RFC 3161 timestamp tokens and Sigstore Rekor log entries. Shared by the
// server (building requests, sanity-checking what came back before storing it), the client (lib/ledger-head.mjs)
// and the offline verifier (scripts/audit-verify.mjs --anchors).
//
// ASN.1 is parsed by asn1js and the CMS / TSP / X.509 structures by pkijs (both PeculiarVentures), with Node's
// webcrypto as the pkijs crypto engine: signature checks and certificate path building are library code, not ours.
// What stays hand-written here is policy (which algorithms, which attributes, which EKU, which roots), a DER
// strictness walk over the asn1js tree (asn1js reads BER), and the one structure pkijs has no class for, the ESS
// signing-certificate(-v2) attribute, read off the asn1js tree with a type check at every step. The Rekor half is
// JSON, SHA-256 and a Merkle walk: it never touched ASN.1 and stays on node:crypto.
//
// What an anchor proves: an outside party that does not share the operator's keys saw this exact 32-byte head hash
// no later than the time it signed. RFC 3161: the TSA signs (genTime, messageImprint). Rekor: the entry is included
// in a public append-only Merkle log whose checkpoint the log signs, and the log signs an entry timestamp (SET).
// Neither says anything about what the ledger rows mean, and neither covers rows written after the anchored head.
import { createHash, createPublicKey, verify as cverify, generateKeyPairSync, sign as csign, randomBytes, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

// A private engine passed explicitly to every pkijs call that does crypto, so nothing depends on (or changes) the
// process-global pkijs engine.
const ENGINE = new pkijs.CryptoEngine({ name: "agentchan-node-webcrypto", crypto: webcrypto });

const OID = {
  sha256: "2.16.840.1.101.3.4.2.1", sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3", sha1: "1.3.14.3.2.26",
  signedData: "1.2.840.113549.1.7.2", tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4",
  signingCert: "1.2.840.113549.1.9.16.2.12", signingCertV2: "1.2.840.113549.1.9.16.2.47",
  timeStamping: "1.3.6.1.5.5.7.3.8", extKeyUsage: "2.5.29.37", subjectKeyId: "2.5.29.14", commonName: "2.5.4.3",
};
const DIGEST = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512", [OID.sha1]: "sha1" };
const WEBCRYPTO_HASH = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" };
// signatureAlgorithm -> hash to verify with (null = take the SignerInfo digestAlgorithm, as for plain rsaEncryption).
// Anything else (RSA-PSS, Ed25519, ...) is refused: this allowlist is unchanged from the hand-written verifier.
const SIGALG = {
  "1.2.840.113549.1.1.1": null, "1.2.840.113549.1.1.11": "sha256", "1.2.840.113549.1.1.12": "sha384", "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256", "1.2.840.10045.4.3.3": "sha384", "1.2.840.10045.4.3.4": "sha512",
};
const MAX_CHAIN = 8;
const H = (alg, b) => createHash(alg).update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");
const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
const bytesEqual = (a, b) => Buffer.from(u8(a)).equals(Buffer.from(u8(b)));
const der = (o) => u8(o.toSchema().toBER());

// ---------------- trust roots ----------------
const ROOTS_DIR = new URL("./anchor-roots/", import.meta.url);
/** The pinned roots shipped with the client: { tsa: [{ name, pem, sha256, source }], rekor: [{ name, pem, source, log_id }] }. */
export function bundledRoots() {
  const m = JSON.parse(readFileSync(new URL("roots.json", ROOTS_DIR), "utf8"));
  const load = (r) => ({ ...r, pem: readFileSync(new URL(r.file, ROOTS_DIR), "utf8") });
  return { tsa: m.tsa.map(load), rekor: m.rekor.map(load) };
}

// ---------------- strict DER on top of asn1js ----------------
// asn1js reads BER. A signature verifier should not: the same value has many BER encodings, and everything signed
// here is DER. So every buffer is parsed by asn1js and the tree is then walked: no indefinite lengths, no non-minimal
// long-form lengths, no constructed encodings of primitive universal types, no trailing bytes. Truncation is asn1js's.
function derStrict(node, where) {
  const len = node.lenBlock;
  if (len.isIndefiniteForm) throw new Error(where + ": indefinite length is not DER");
  if (len.longFormUsed && (len.length < 0x80 || node.valueBeforeDecodeView[node.idBlock.blockLength + 1] === 0)) throw new Error(where + ": non-minimal length is not DER");
  const { isConstructed, tagClass, tagNumber } = node.idBlock;
  if (isConstructed && tagClass === 1 && tagNumber !== 16 && tagNumber !== 17) throw new Error(where + ": constructed encoding of a primitive type is not DER");
  if (isConstructed) for (const c of node.valueBlock.value || []) derStrict(c, where);
}
/** Parse bytes that must be exactly one DER element; returns the asn1js tree. */
export function parseDer(bytes, where = "DER") {
  const b = u8(bytes);
  if (b.byteLength < 2) throw new Error(where + ": truncated");
  const r = asn1js.fromBER(b);
  if (r.offset === -1 || r.result.error) throw new Error(where + ": does not parse (" + (r.result.error || "malformed") + ")");
  if (r.offset !== b.byteLength) throw new Error(where + ": trailing bytes after the top-level element");
  derStrict(r.result, where);
  return r.result;
}
const oidOf = (n) => { if (!(n instanceof asn1js.ObjectIdentifier)) throw new Error("expected OBJECT IDENTIFIER"); return n.valueBlock.toString(); };
const cn = (name) => name.typesAndValues.find((t) => t.type === OID.commonName)?.value?.valueBlock?.value ?? name.typesAndValues.map((t) => t.value?.valueBlock?.value).join(", ");
const exts = (cert, id) => (cert.extensions || []).filter((e) => e.extnID === id);
const pemOrDer = (p) => (p instanceof Uint8Array ? u8(p) : u8(Buffer.from(String(p).replace(/-----[^-]+-----|\s/g, ""), "base64")));

// ---------------- RFC 3161 ----------------
/** TimeStampReq for a sha256 digest (hex). certReq=true so the token carries the TSA's chain. */
export function buildTsaRequest(hashHex, nonce = randomBytes(8)) {
  const h = Buffer.from(hashHex, "hex");
  if (h.length !== 32) throw new Error("TSA request: expected a 32-byte sha256 digest");
  // the nonce is a positive INTEGER: leading zero bytes dropped, a 0x00 pad when the top bit is set (asn1js takes
  // valueHex as the two's-complement content octets verbatim)
  let i = 0;
  while (i < nonce.length - 1 && nonce[i] === 0) i++;
  let nb = Buffer.from(nonce.subarray(i));
  if (nb[0] & 0x80) nb = Buffer.concat([Buffer.from([0]), nb]);
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({ hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256, algorithmParams: new asn1js.Null() }), hashedMessage: new asn1js.OctetString({ valueHex: h }) }),
    nonce: new asn1js.Integer({ valueHex: nb }),
    certReq: true,
  });
  return { der: Buffer.from(der(req)), nonce: hex(nonce) };
}

/** TimeStampResp -> { status, token (DER Buffer) }; throws on a rejection with the PKIStatus text. */
export function parseTsaResponse(bytes) {
  const tree = parseDer(bytes, "TimeStampResp");
  const resp = new pkijs.TimeStampResp({ schema: tree });
  const status = resp.status.status;
  if (status !== 0 && status !== 1) {
    const text = (resp.status.statusStrings || []).map((s) => s.valueBlock.value).join("; ");
    throw new Error("TSA refused the request (PKIStatus " + status + (text ? ": " + text : "") + ")");
  }
  if (!resp.timeStampToken) throw new Error("TSA response has no timeStampToken");
  // the token's bytes as received, never a re-encoding: what was signed is what gets stored
  return { status, token: Buffer.from(tree.valueBlock.value[1].valueBeforeDecodeView) };
}

/** Parse a timeStampToken (CMS ContentInfo) without judging it. Throws unless it is a DER SignedData over a TSTInfo. */
export function parseTsaToken(tokenDer) {
  const ci = new pkijs.ContentInfo({ schema: parseDer(tokenDer, "timeStampToken") });
  if (ci.contentType !== OID.signedData) throw new Error("token is not CMS SignedData");
  const sd = new pkijs.SignedData({ schema: ci.content });
  if (sd.encapContentInfo.eContentType !== OID.tstInfo) throw new Error("token content is not TSTInfo");
  const ec = sd.encapContentInfo.eContent;
  if (!(ec instanceof asn1js.OctetString) || ec.idBlock.isConstructed) throw new Error("TSTInfo is not a primitive OCTET STRING");
  const eContent = Buffer.from(ec.valueBlock.valueHexView);
  const tstTree = parseDer(eContent, "TSTInfo");
  const tst = new pkijs.TSTInfo({ schema: tstTree });
  // genTime must be a UTC GeneralizedTime ("Z"): a local-time form would leave the instant ambiguous
  const gt = tstTree.valueBlock.value[4];
  if (!(gt instanceof asn1js.GeneralizedTime) || !/^\d{14}(?:[.,]\d+)?Z$/.test(Buffer.from(gt.valueBlock.valueHexView).toString("latin1"))) throw new Error("TSTInfo genTime is not a UTC GeneralizedTime");
  // RFC 3161 2.4.2: the token carries no signature other than the TSA's
  if (sd.signerInfos.length !== 1) throw new Error("token has " + sd.signerInfos.length + " signers; RFC 3161 allows only the TSA's");
  const si = sd.signerInfos[0];
  const certs = (sd.certificates || []).filter((c) => c instanceof pkijs.Certificate);
  const attrs = {}, dupAttrs = [];
  for (const a of si.signedAttrs?.attributes || []) { if (attrs[a.type]) dupAttrs.push(a.type); attrs[a.type] = a; }
  const acc = tst.accuracy;
  return {
    policy: tst.policy,
    imprintAlg: DIGEST[tst.messageImprint.hashAlgorithm.algorithmId] || tst.messageImprint.hashAlgorithm.algorithmId,
    imprint: hex(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    serial: tst.serialNumber.toBigInt().toString(16),
    genTime: tst.genTime,
    accuracy: acc ? { seconds: acc.seconds ?? 0, millis: acc.millis ?? 0, micros: acc.micros ?? 0 } : null,
    nonce: tst.nonce ? tst.nonce.toBigInt().toString(16) : null,
    eContent,
    certs: certs.map((c) => Buffer.from(der(c))),
    digestAlg: DIGEST[si.digestAlgorithm.algorithmId],
    sigAlg: si.signatureAlgorithm.algorithmId,
    attrs, dupAttrs,
    signerInfo: si, certObjects: certs,
  };
}

// ESS signing-certificate (RFC 2634) / -v2 (RFC 5035). pkijs has no class for these, so they are read off the asn1js
// tree, checking every node's type before use. Returns the first ESSCertID{v2} as { alg, hash, serial }.
function essFirstCertId(attr, v2) {
  if (attr.values.length !== 1) throw new Error("must have exactly one value");
  const sc = attr.values[0];
  if (!(sc instanceof asn1js.Sequence)) throw new Error("SigningCertificate is not a SEQUENCE");
  const certIds = sc.valueBlock.value[0];
  if (!(certIds instanceof asn1js.Sequence) || !certIds.valueBlock.value.length) throw new Error("SigningCertificate has no ESSCertID");
  const id = certIds.valueBlock.value[0];
  if (!(id instanceof asn1js.Sequence)) throw new Error("ESSCertID is not a SEQUENCE");
  const f = [...id.valueBlock.value];
  let alg = v2 ? "sha256" : "sha1"; // ESSCertIDv2.hashAlgorithm DEFAULT sha256; ESSCertID is always sha1
  if (v2 && f[0] instanceof asn1js.Sequence) {
    alg = DIGEST[oidOf(f.shift().valueBlock.value[0])];
    if (!alg || alg === "sha1") throw new Error("unsupported ESSCertIDv2 hash algorithm");
  }
  const hash = f.shift();
  if (!(hash instanceof asn1js.OctetString) || hash.idBlock.isConstructed) throw new Error("certHash is not an OCTET STRING");
  let serial = null;
  const is = f.shift(); // IssuerSerial ::= SEQUENCE { issuer GeneralNames, serialNumber CertificateSerialNumber }
  if (is !== undefined) {
    if (!(is instanceof asn1js.Sequence) || !(is.valueBlock.value[1] instanceof asn1js.Integer)) throw new Error("issuerSerial is malformed");
    serial = hex(is.valueBlock.value[1].valueBlock.valueHexView);
  }
  return { alg, hash: Buffer.from(hash.valueBlock.valueHexView), serial };
}

const validAt = (c, at) => at >= c.notBefore.value.getTime() && at <= c.notAfter.value.getTime();
// a token certificate with a pinned root's subject and key is a (cross-signed) copy of that root
const copyOfRoot = (root, c) => bytesEqual(der(root.subjectPublicKeyInfo), der(c.subjectPublicKeyInfo)) && bytesEqual(der(root.subject), der(c.subject));

/**
 * verifyTsaToken(tokenDer, { hashHex, roots: [pem], nonceHex? }) -> Promise<{ ok, problems[], genTime, tsa, chain[], policy, serial }>
 * Checks: the token is DER with one SignerInfo over a TSTInfo; messageImprint == hashHex (sha256); the contentType
 * and messageDigest signed attributes (each exactly once, no attribute repeated); an ESS signing-certificate(-v2)
 * attribute naming the signer certificate; the SignerInfo signature over the signed attributes with that
 * certificate's key; the signer's extended key usage is critical and timeStamping only (RFC 3161 2.3); and pkijs's
 * certificate path validation from the signer to one of `roots`: every link signature-checked, every issuer a CA,
 * every certificate valid at genTime. NOT checked: revocation (CRL/OCSP), because an offline verifier cannot, and a
 * long-term check would need the revocation state as of genTime.
 */
export async function verifyTsaToken(tokenDer, { hashHex, roots = [], nonceHex = null } = {}) {
  const problems = [];
  let t;
  try { t = parseTsaToken(tokenDer); } catch (e) { return { ok: false, problems: ["token does not parse: " + e.message], chain: [] }; }
  const out = { genTime: t.genTime.toISOString(), policy: t.policy, serial: t.serial, tsa: null, chain: [], problems };
  try {
    await checkToken(t, { hashHex, roots, nonceHex }, out);
  } catch (e) { problems.push("token does not verify: " + e.message); }
  out.ok = problems.length === 0;
  return out;
}

async function checkToken(t, { hashHex, roots, nonceHex }, out) {
  const problems = out.problems;
  if (t.imprintAlg !== "sha256") problems.push("messageImprint uses " + t.imprintAlg + ", expected sha256");
  if (!hashHex) problems.push("no head hash to check the messageImprint against");
  else if (t.imprint !== String(hashHex).toLowerCase()) problems.push("messageImprint " + t.imprint.slice(0, 16) + "… is not the head hash " + String(hashHex).slice(0, 16) + "…");
  if (nonceHex && t.nonce !== null && BigInt("0x" + t.nonce) !== BigInt("0x" + nonceHex)) problems.push("nonce in the token is not the nonce we sent");
  if (!t.digestAlg) problems.push("unsupported SignerInfo digest algorithm");
  const si = t.signerInfo;
  if (!si.signedAttrs) { problems.push("SignerInfo has no signed attributes"); return; }
  if (t.dupAttrs.length) problems.push("signed attribute(s) appear more than once: " + [...new Set(t.dupAttrs)].join(", "));
  const ct = t.attrs[OID.contentType];
  if (!ct || ct.values.length !== 1 || !(ct.values[0] instanceof asn1js.ObjectIdentifier) || oidOf(ct.values[0]) !== OID.tstInfo) problems.push("signed contentType is not TSTInfo");
  const md = t.attrs[OID.messageDigest];
  const mdv = md?.values.length === 1 && md.values[0] instanceof asn1js.OctetString && !md.values[0].idBlock.isConstructed ? Buffer.from(md.values[0].valueBlock.valueHexView) : null;
  if (!mdv || !t.digestAlg || !H(t.digestAlg, t.eContent).equals(mdv)) problems.push("signed messageDigest does not match the TSTInfo");

  // signer certificate: by issuerAndSerialNumber (exact DER of the issuer Name and serial), or subjectKeyIdentifier
  let signer = null;
  if (si.sid instanceof pkijs.IssuerAndSerialNumber) {
    const wantIssuer = der(si.sid.issuer), wantSerial = si.sid.serialNumber.valueBlock.valueHexView;
    signer = t.certObjects.find((c) => bytesEqual(der(c.issuer), wantIssuer) && bytesEqual(c.serialNumber.valueBlock.valueHexView, wantSerial));
  } else if (si.sid?.idBlock?.tagClass === 3 && si.sid.idBlock.tagNumber === 0 && !si.sid.idBlock.isConstructed) {
    const ski = si.sid.valueBlock.valueHexView;
    signer = t.certObjects.find((c) => exts(c, OID.subjectKeyId).some((e) => e.parsedValue instanceof asn1js.OctetString && bytesEqual(e.parsedValue.valueBlock.valueHexView, ski)));
  }
  if (!signer) { problems.push("the signer's certificate is not in the token (request with certReq=true)"); return; }
  out.tsa = cn(signer.subject);
  const signerDer = Buffer.from(der(signer));

  // ESS signing-certificate: binds the signature to this certificate and not a look-alike. RFC 3161 (updated by
  // RFC 5816) requires one of the two attributes; when both are present, both must name the signer.
  const ess = [[t.attrs[OID.signingCertV2], true], [t.attrs[OID.signingCert], false]].filter(([a]) => a);
  if (!ess.length) problems.push("no signing-certificate attribute: the signature is not bound to a certificate");
  for (const [a, v2] of ess) {
    let id;
    try { id = essFirstCertId(a, v2); } catch (e) { problems.push("signing-certificate attribute: " + e.message); continue; }
    if (!H(id.alg, signerDer).equals(id.hash)) problems.push("signing-certificate attribute does not name the signer certificate");
    else if (id.serial !== null && id.serial !== hex(signer.serialNumber.valueBlock.valueHexView)) problems.push("signing-certificate attribute names another serial number");
  }

  // signature over DER(SET OF signedAttrs) exactly as received: pkijs keeps the original bytes, re-tagged 0x31
  const plainRsa = SIGALG[t.sigAlg] === null;
  if (SIGALG[t.sigAlg] === undefined) problems.push("unsupported signature algorithm " + t.sigAlg);
  else if (plainRsa && !t.digestAlg) problems.push("rsaEncryption signature with an unsupported digest algorithm");
  else {
    let ok = false;
    try { ok = await ENGINE.verifyWithPublicKey(si.signedAttrs.encodedValue, si.signature, signer.subjectPublicKeyInfo, si.signatureAlgorithm, plainRsa ? WEBCRYPTO_HASH[t.digestAlg] : undefined); }
    catch (e) { problems.push("signature check threw: " + e.message); }
    if (!ok) problems.push("TSA signature does not verify with the signer certificate");
  }

  // RFC 3161 2.3: exactly one EKU extension, critical, with timeStamping as its only purpose
  const eku = exts(signer, OID.extKeyUsage);
  const purposes = eku[0]?.parsedValue?.keyPurposes || [];
  if (eku.length !== 1 || !purposes.includes(OID.timeStamping)) problems.push("signer certificate lacks the timeStamping extended key usage");
  else if (eku[0].critical !== true) problems.push("signer certificate's timeStamping extended key usage is not critical");
  else if (purposes.length !== 1) problems.push("signer certificate's extended key usage is not timeStamping only");
  const unknownCritical = (signer.extensions || []).filter((e) => e.critical && !e.parsedValue).map((e) => e.extnID);
  if (unknownCritical.length) problems.push("signer certificate has unrecognised critical extension(s) " + unknownCritical.join(", "));

  const at = t.genTime.getTime();
  if (!validAt(signer, at)) problems.push("certificate " + out.tsa + " was not valid at genTime");

  // chain: pkijs path validation, signer -> ... -> a pinned root, at genTime. Trust is the pinned certificate, never
  // the token's copy: a token certificate with a pinned root's subject and key (a cross-signed copy of the root, as
  // DigiCert ships) is left out, so the path ends at the pinned certificate itself. pkijs also abandons the whole
  // search when any branch dead-ends, and a cross-signed root whose own issuer is not in the token is such a branch.
  const rootCerts = [];
  for (const p of roots) {
    try { rootCerts.push(pkijs.Certificate.fromBER(pemOrDer(p))); } catch (e) { problems.push("a supplied root does not parse: " + e.message); }
  }
  const intermediates = t.certObjects.filter((c) => c !== signer && !rootCerts.some((r) => copyOfRoot(r, c)));
  let path = null, why = null;
  if (rootCerts.length) {
    try {
      const engine = new pkijs.CertificateChainValidationEngine({ trustedCerts: rootCerts, certs: [...intermediates, signer], checkDate: t.genTime });
      const r = await engine.verify({}, ENGINE);
      if (r.result) path = r.certificatePath; else why = r.resultMessage;
    } catch (e) { why = e?.resultMessage || e?.message || String(e); }
  }
  if (!path) { problems.push("no chain from the TSA certificate to a pinned root (" + (rootCerts.length ? rootCerts.map((r) => cn(r.subject)).join(", ") : "no roots supplied") + ")" + (why ? ": " + why : "")); return; }
  // pkijs returns the path leaf first. Re-assert what it already checked, so a change in its behaviour fails closed.
  const top = path.at(-1);
  const pinned = rootCerts.find((r) => bytesEqual(der(r), der(top)));
  if (!bytesEqual(der(path[0]), signerDer)) problems.push("chain does not start at the signer certificate");
  if (!pinned) problems.push("chain does not end at a pinned root");
  if (path.length > MAX_CHAIN) problems.push("certificate chain is longer than " + MAX_CHAIN);
  for (const c of path.slice(1)) if (!validAt(c, at)) problems.push("certificate " + cn(c.subject) + " was not valid at genTime");
  out.chain = path.map((c, i) => cn(c.subject) + (i === path.length - 1 && pinned ? " (pinned root)" : ""));
}

// ---------------- Sigstore Rekor (v1 API, hashedrekord) ----------------
/**
 * A hashedrekord proposed entry for the head hash. Rekor requires a signature over the artifact; the artifact is the
 * head row's canonical string (the preimage of its hash, which never leaves the server: only the hash and the
 * signature are sent). The key is ephemeral and single-use, so the signature carries no identity: what matters is
 * that the log recorded this hash, not who signed it. canonical must hash (sha256) to hashHex.
 */
export function buildRekorEntry(canonical, hashHex) {
  if (hex(H("sha256", Buffer.from(canonical, "utf8"))) !== hashHex) throw new Error("rekor entry: canonical does not hash to the head hash");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sig = csign("sha256", Buffer.from(canonical, "utf8"), privateKey);
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { apiVersion: "0.0.1", kind: "hashedrekord", spec: { signature: { content: sig.toString("base64"), publicKey: { content: Buffer.from(pem).toString("base64") } }, data: { hash: { algorithm: "sha256", value: hashHex } } } };
}

/** RFC 6962 / 9162 inclusion proof: leaf at index in a tree of treeSize, proof hashes -> computed root (hex). */
export function rootFromInclusionProof(leafHashHex, index, treeSize, proofHex) {
  let fn = BigInt(index), sn = BigInt(treeSize) - 1n;
  if (fn > sn) throw new Error("inclusion proof: index beyond tree size");
  let r = Buffer.from(leafHashHex, "hex");
  const node = (a, b) => H("sha256", Buffer.concat([Buffer.from([1]), a, b]));
  for (const ph of proofHex) {
    const p = Buffer.from(ph, "hex");
    if (sn === 0n) throw new Error("inclusion proof: too many hashes");
    if ((fn & 1n) === 1n || fn === sn) {
      r = node(p, r);
      if ((fn & 1n) === 0n) while ((fn & 1n) === 0n && fn !== 0n) { fn >>= 1n; sn >>= 1n; }
    } else r = node(r, p);
    fn >>= 1n; sn >>= 1n;
  }
  if (sn !== 0n) throw new Error("inclusion proof: too few hashes");
  return hex(r);
}

const canonSorted = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? "[" + v.map(canonSorted).join(",") + "]" : "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonSorted(v[k])).join(",") + "}";

/**
 * verifyRekorEntry(entry, { hashHex, keys: [pem] }) where entry = { uuid, body, integratedTime, logID, logIndex, verification }
 * (one value of Rekor's POST/GET response map, with its key as uuid). Checks: the logged body is a hashedrekord of
 * hashHex; the leaf hash (sha256(0x00 || body)) is the uuid's tail; the inclusion proof reaches rootHash; the
 * checkpoint is signed by a pinned log key and states that rootHash and treeSize; the signed entry timestamp verifies.
 */
export function verifyRekorEntry(entry, { hashHex, keys = [] } = {}) {
  const problems = [];
  const out = { problems, integratedTime: entry?.integratedTime ? new Date(entry.integratedTime * 1000).toISOString() : null, logIndex: entry?.logIndex ?? null, uuid: entry?.uuid ?? null, log: null };
  try {
    const bodyBytes = Buffer.from(entry.body, "base64");
    const body = JSON.parse(bodyBytes.toString("utf8"));
    if (body.kind !== "hashedrekord") problems.push("entry kind is " + body.kind + ", expected hashedrekord");
    const h = body.spec?.data?.hash;
    if (h?.algorithm !== "sha256" || (hashHex && h.value !== hashHex)) problems.push("logged hash " + String(h?.value).slice(0, 16) + "… is not the head hash " + String(hashHex).slice(0, 16) + "…");
    const leaf = hex(H("sha256", Buffer.concat([Buffer.from([0]), bodyBytes])));
    if (entry.uuid && !String(entry.uuid).endsWith(leaf)) problems.push("entry uuid does not end with the leaf hash of its body");
    const pinned = keys.map((pem) => { const k = createPublicKey(pem); return { k, id: hex(H("sha256", k.export({ type: "spki", format: "der" }))) }; });
    const key = pinned.find((p) => p.id === entry.logID);
    if (!key) problems.push("logID " + String(entry.logID).slice(0, 16) + "… is not a pinned Rekor key");
    out.log = entry.logID;
    const ip = entry.verification?.inclusionProof;
    if (!ip) problems.push("no inclusion proof");
    else {
      let root = null;
      try { root = rootFromInclusionProof(leaf, ip.logIndex, ip.treeSize, ip.hashes || []); } catch (e) { problems.push(e.message); }
      if (root && root !== ip.rootHash) problems.push("inclusion proof does not reach the stated root hash");
      // checkpoint: a signed note. Body = text up to and including the blank line's preceding newline.
      const cp = String(ip.checkpoint || "");
      const sep = cp.indexOf("\n\n");
      if (sep < 0) problems.push("checkpoint is not a signed note");
      else {
        const text = cp.slice(0, sep + 1);
        const [, size, rootB64] = text.split("\n");
        if (Number(size) !== Number(ip.treeSize) || Buffer.from(rootB64 || "", "base64").toString("hex") !== ip.rootHash) problems.push("checkpoint does not state the proof's tree size and root");
        const sigs = cp.slice(sep + 2).split("\n").filter((l) => l.startsWith("— "));
        const good = key && sigs.some((l) => { const raw = Buffer.from(l.split(" ").at(-1), "base64"); try { return cverify("sha256", Buffer.from(text, "utf8"), key.k, raw.subarray(4)); } catch { return false; } });
        if (key && !good) problems.push("checkpoint signature does not verify with the pinned log key");
      }
    }
    const set = entry.verification?.signedEntryTimestamp;
    if (!set) problems.push("no signed entry timestamp");
    else if (key) {
      const payload = canonSorted({ body: entry.body, integratedTime: entry.integratedTime, logID: entry.logID, logIndex: entry.logIndex });
      let ok = false; try { ok = cverify("sha256", Buffer.from(payload, "utf8"), key.k, Buffer.from(set, "base64")); } catch {}
      if (!ok) problems.push("signed entry timestamp does not verify");
    }
  } catch (e) { problems.push("entry does not parse: " + e.message); }
  out.ok = problems.length === 0;
  return out;
}

/** Normalise Rekor's { "<uuid>": {...} } response map into one entry with its uuid. */
export function rekorEntryFromResponse(json) {
  const [uuid, v] = Object.entries(json || {})[0] || [];
  if (!uuid) throw new Error("Rekor response has no entry");
  return { uuid, ...v };
}

/**
 * verifyAnchor(row, { roots }) -> Promise<result> for one stored anchor row { kind, head_hash, token_b64 | entry }: dispatch by kind.
 * roots defaults to the bundled pinned set; an auditor passes their own TSA roots for a bank deployment.
 */
export async function verifyAnchor(a, roots = bundledRoots()) {
  if (a.kind === "rfc3161") return verifyTsaToken(Buffer.from(a.token_b64 ?? a.proof?.token_b64, "base64"), { hashHex: a.head_hash, roots: roots.tsa.map((r) => r.pem ?? r) });
  if (a.kind === "rekor") return verifyRekorEntry(a.entry ?? a.proof?.entry, { hashHex: a.head_hash, keys: roots.rekor.map((r) => r.pem ?? r) });
  return { ok: false, problems: ["unknown anchor kind " + a.kind] };
}
