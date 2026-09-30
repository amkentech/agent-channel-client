// External anchors for the ledger head: RFC 3161 timestamp tokens and Sigstore Rekor log entries, built and verified
// with node:crypto and lib/der.mjs only. Shared by the server (building requests, sanity-checking what came back
// before storing it), the client (lib/ledger-head.mjs) and the offline verifier (scripts/audit-verify.mjs --anchors).
//
// What an anchor proves: an outside party that does not share the operator's keys saw this exact 32-byte head hash
// no later than the time it signed. RFC 3161: the TSA signs (genTime, messageImprint). Rekor: the entry is included
// in a public append-only Merkle log whose checkpoint the log signs, and the log signs an entry timestamp (SET).
// Neither says anything about what the ledger rows mean, and neither covers rows written after the anchored head.
import { createHash, createPublicKey, verify as cverify, X509Certificate, generateKeyPairSync, sign as csign, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAll, oid, int, time, isCtx, seq, objectId, nul, octets, integerBytes, integer, bool } from "./der.mjs";

const OID = {
  sha256: "2.16.840.1.101.3.4.2.1", sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3", sha1: "1.3.14.3.2.26",
  signedData: "1.2.840.113549.1.7.2", tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4",
  signingCert: "1.2.840.113549.1.9.16.2.12", signingCertV2: "1.2.840.113549.1.9.16.2.47",
  timeStamping: "1.3.6.1.5.5.7.3.8",
};
const DIGEST = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512", [OID.sha1]: "sha1" };
// signatureAlgorithm -> hash to verify with (null = take the SignerInfo digestAlgorithm, as for plain rsaEncryption)
const SIGALG = {
  "1.2.840.113549.1.1.1": null, "1.2.840.113549.1.1.11": "sha256", "1.2.840.113549.1.1.12": "sha384", "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.10045.4.3.2": "sha256", "1.2.840.10045.4.3.3": "sha384", "1.2.840.10045.4.3.4": "sha512",
};
const H = (alg, b) => createHash(alg).update(b).digest();
const hex = (b) => Buffer.from(b).toString("hex");

// ---------------- trust roots ----------------
const ROOTS_DIR = new URL("./anchor-roots/", import.meta.url);
/** The pinned roots shipped with the client: { tsa: [{ name, pem, sha256, source }], rekor: [{ name, pem, source, log_id }] }. */
export function bundledRoots() {
  const m = JSON.parse(readFileSync(new URL("roots.json", ROOTS_DIR), "utf8"));
  const load = (r) => ({ ...r, pem: readFileSync(new URL(r.file, ROOTS_DIR), "utf8") });
  return { tsa: m.tsa.map(load), rekor: m.rekor.map(load) };
}

// ---------------- RFC 3161 ----------------
/** TimeStampReq for a sha256 digest (hex). certReq=true so the token carries the TSA's chain. */
export function buildTsaRequest(hashHex, nonce = randomBytes(8)) {
  const h = Buffer.from(hashHex, "hex");
  if (h.length !== 32) throw new Error("TSA request: expected a 32-byte sha256 digest");
  return { der: seq(integer(1), seq(seq(objectId(OID.sha256), nul()), octets(h)), integerBytes(nonce), bool(true)), nonce: hex(nonce) };
}

/** TimeStampResp -> { status, token (DER Buffer) }; throws on a rejection with the PKIStatus text. */
export function parseTsaResponse(der) {
  const r = parseAll(der);
  const statusInfo = r.children[0];
  const status = Number(int(statusInfo.children[0]));
  if (status !== 0 && status !== 1) {
    const text = statusInfo.children[1]?.children?.map((c) => c.value.toString("utf8")).join("; ");
    throw new Error("TSA refused the request (PKIStatus " + status + (text ? ": " + text : "") + ")");
  }
  if (!r.children[1]) throw new Error("TSA response has no timeStampToken");
  return { status, token: Buffer.from(r.children[1].raw) };
}

/** Parse a timeStampToken (CMS ContentInfo) without judging it. */
export function parseTsaToken(tokenDer) {
  const ci = parseAll(tokenDer);
  if (oid(ci.children[0]) !== OID.signedData) throw new Error("token is not CMS SignedData");
  const sd = ci.children[1].children[0];
  const eci = sd.children.find((c, i) => i > 1 && c.tag === 0x30);
  if (oid(eci.children[0]) !== OID.tstInfo) throw new Error("token content is not TSTInfo");
  const eContent = eci.children[1].children[0].value;
  const tst = parseAll(eContent);
  const mi = tst.children[2];
  let k = 5;
  const accuracy = tst.children[k]?.tag === 0x30 ? tst.children[k++] : null;
  if (tst.children[k]?.tag === 0x01) k++; // ordering
  const nonce = tst.children[k]?.tag === 0x02 ? int(tst.children[k]) : null;
  const certsNode = sd.children.find((c) => isCtx(c, 0));
  const certs = (certsNode?.children || []).filter((c) => c.tag === 0x30).map((c) => Buffer.from(c.raw));
  const signerInfos = sd.children.at(-1);
  const si = signerInfos.children[0];
  const signedAttrs = si.children.find((c) => isCtx(c, 0));
  const sigAlgNode = si.children.find((c, i) => i > 2 && c.tag === 0x30);
  const attrs = {};
  for (const a of signedAttrs?.children || []) attrs[oid(a.children[0])] = a.children[1].children[0];
  return {
    policy: oid(tst.children[1]),
    imprintAlg: DIGEST[oid(mi.children[0].children[0])] || oid(mi.children[0].children[0]),
    imprint: hex(mi.children[1].value),
    serial: int(tst.children[3]).toString(16),
    genTime: time(tst.children[4]),
    accuracy: accuracy ? accuracy.children.map((c) => (c.tag === 0x02 ? Number(int(c)) : c.value.length ? Number(BigInt("0x" + hex(c.value))) : 0)) : null,
    nonce: nonce === null ? null : nonce.toString(16),
    eContent, certs, sid: si.children[1], digestAlg: DIGEST[oid(si.children[2].children[0])],
    signedAttrs, attrs, sigAlg: oid(sigAlgNode.children[0]), signature: si.children.find((c) => c.tag === 0x04 && c !== si.children[1]).value,
  };
}

// tbsCertificate fields we need that X509Certificate does not expose as bytes: issuer Name DER and serial bytes
function certIssuerSerial(der) {
  const tbs = parseAll(der).children[0];
  const i = isCtx(tbs.children[0], 0) ? 1 : 0;
  return { serial: hex(tbs.children[i].value), issuer: hex(tbs.children[i + 2].raw) };
}
// subjectKeyIdentifier extension (2.5.29.14) value, hex, or null
function certSki(der) {
  try {
    const tbs = parseAll(der).children[0];
    const exts = tbs.children.find((c) => isCtx(c, 3));
    for (const e of exts?.children[0]?.children || []) if (oid(e.children[0]) === "2.5.29.14") return hex(parseAll(e.children.at(-1).value).value);
  } catch {}
  return null;
}

/**
 * verifyTsaToken(tokenDer, { hashHex, roots: [pem], nonceHex? }) -> { ok, problems[], genTime, tsa, chain[], policy, serial }
 * Checks: messageImprint == hashHex (sha256); contentType and messageDigest signed attributes; the SignerInfo
 * signature over the signed attributes with the signer certificate's key; the signing-certificate attribute names
 * that certificate; the signer is a timeStamping-EKU certificate valid at genTime; and a chain from it to one of
 * `roots`, every link signature-checked and valid at genTime. NOT checked: revocation (CRL/OCSP), because an offline
 * verifier cannot, and a long-term check would need the revocation state as of genTime.
 */
export function verifyTsaToken(tokenDer, { hashHex, roots = [], nonceHex = null } = {}) {
  const problems = [];
  let t;
  try { t = parseTsaToken(tokenDer); } catch (e) { return { ok: false, problems: ["token does not parse: " + e.message] }; }
  const out = { genTime: t.genTime.toISOString(), policy: t.policy, serial: t.serial, tsa: null, chain: [], problems };
  if (t.imprintAlg !== "sha256") problems.push("messageImprint uses " + t.imprintAlg + ", expected sha256");
  if (hashHex && t.imprint !== String(hashHex).toLowerCase()) problems.push("messageImprint " + t.imprint.slice(0, 16) + "… is not the head hash " + String(hashHex).slice(0, 16) + "…");
  if (nonceHex && t.nonce !== null && BigInt("0x" + t.nonce) !== BigInt("0x" + nonceHex)) problems.push("nonce in the token is not the nonce we sent");
  if (!t.digestAlg) problems.push("unsupported SignerInfo digest algorithm");
  if (!t.signedAttrs) problems.push("SignerInfo has no signed attributes");
  else {
    if (t.attrs[OID.contentType] && oid(t.attrs[OID.contentType]) !== OID.tstInfo) problems.push("signed contentType is not TSTInfo");
    const md = t.attrs[OID.messageDigest];
    if (!md || !t.digestAlg || !H(t.digestAlg, t.eContent).equals(md.value)) problems.push("signed messageDigest does not match the TSTInfo");
  }
  // signer certificate: by issuerAndSerialNumber, or subjectKeyIdentifier
  const certs = t.certs.map((d) => ({ der: d, x: new X509Certificate(d), is: certIssuerSerial(d) }));
  let signer = null;
  if (t.sid.tag === 0x30) {
    const wantIssuer = hex(t.sid.children[0].raw), wantSerial = hex(t.sid.children[1].value);
    signer = certs.find((c) => c.is.issuer === wantIssuer && c.is.serial === wantSerial);
  } else if (isCtx(t.sid, 0)) {
    const ski = hex(t.sid.value);
    signer = certs.find((c) => certSki(c.der) === ski);
  }
  if (!signer) { problems.push("the signer's certificate is not in the token (request with certReq=true)"); out.ok = false; return out; }
  out.tsa = signer.x.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) || signer.x.subject.replace(/\n/g, ", ");
  // signing-certificate attribute (ESS): binds the signature to this certificate and not a look-alike
  const essV2 = t.attrs[OID.signingCertV2], ess = t.attrs[OID.signingCert];
  if (essV2 || ess) {
    const certIds = (essV2 || ess).children[0].children;
    const first = certIds[0];
    let alg = "sha1", hashNode = first.children[0];
    if (essV2) { if (first.children[0].tag === 0x30) { alg = DIGEST[oid(first.children[0].children[0])] || "sha256"; hashNode = first.children[1]; } else alg = "sha256"; }
    if (!H(alg, signer.der).equals(hashNode.value)) problems.push("signing-certificate attribute does not name the signer certificate");
  }
  // signature over DER(SET OF signedAttrs): the [0] IMPLICIT tag is re-tagged as a SET for hashing
  if (t.signedAttrs) {
    const signedBytes = Buffer.from(t.signedAttrs.raw); signedBytes[0] = 0x31;
    const alg = SIGALG[t.sigAlg] === undefined ? undefined : SIGALG[t.sigAlg] || t.digestAlg;
    if (!alg) problems.push("unsupported signature algorithm " + t.sigAlg);
    else {
      let ok = false;
      try { ok = cverify(alg, signedBytes, signer.x.publicKey, t.signature); } catch (e) { problems.push("signature check threw: " + e.message); }
      if (!ok) problems.push("TSA signature does not verify with the signer certificate");
    }
  }
  const at = t.genTime.getTime();
  const validAt = (x) => at >= Date.parse(x.validFrom) && at <= Date.parse(x.validTo);
  if (!(signer.x.keyUsage || []).includes(OID.timeStamping)) problems.push("signer certificate lacks the timeStamping extended key usage");
  // chain: signer -> ... -> a pinned root (a token cert whose key the pinned root verifies ends the chain too, which
  // is how a cross-signed copy of the root inside the token is handled: trust is the pinned key, never the token's copy)
  const rootX = roots.map((p) => new X509Certificate(p));
  let cur = signer.x, guard = 0, anchored = null;
  const seen = new Set();
  while (guard++ < 8) {
    if (!validAt(cur)) problems.push("certificate " + cur.subject.split("\n").find((l) => l.startsWith("CN=")) + " was not valid at genTime");
    out.chain.push(cur.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) || cur.subject);
    const root = rootX.find((r) => cur.checkIssued(r) && safeVerify(cur, r.publicKey));
    if (root) { anchored = root; if (root.fingerprint256 !== cur.fingerprint256) out.chain.push(root.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3) + " (pinned root)"); else out.chain[out.chain.length - 1] += " (pinned root)"; break; }
    seen.add(cur.fingerprint256);
    const next = certs.map((c) => c.x).find((c) => !seen.has(c.fingerprint256) && cur.checkIssued(c) && c.ca && safeVerify(cur, c.publicKey));
    if (!next) break;
    cur = next;
  }
  if (!anchored) problems.push("no chain from the TSA certificate to a pinned root (" + (rootX.length ? rootX.map((r) => r.subject.split("\n").find((l) => l.startsWith("CN="))?.slice(3)).join(", ") : "no roots supplied") + ")");
  else if (!validAt(anchored)) problems.push("the pinned root was not valid at genTime");
  out.ok = problems.length === 0;
  return out;
}
const safeVerify = (x, key) => { try { return x.verify(key); } catch { return false; } };

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
 * verifyAnchor(row, { roots }) for one stored anchor row { kind, head_hash, token_b64 | entry }: dispatch by kind.
 * roots defaults to the bundled pinned set; an auditor passes their own TSA roots for a bank deployment.
 */
export function verifyAnchor(a, roots = bundledRoots()) {
  if (a.kind === "rfc3161") return verifyTsaToken(Buffer.from(a.token_b64 ?? a.proof?.token_b64, "base64"), { hashHex: a.head_hash, roots: roots.tsa.map((r) => r.pem ?? r) });
  if (a.kind === "rekor") return verifyRekorEntry(a.entry ?? a.proof?.entry, { hashHex: a.head_hash, keys: roots.rekor.map((r) => r.pem ?? r) });
  return { ok: false, problems: ["unknown anchor kind " + a.kind] };
}
