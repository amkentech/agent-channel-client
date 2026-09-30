// End-to-end artifact encryption. Runs on the sender's and receiver's machines only.
// Scheme (v1): random 256-bit content key -> AES-256-GCM over the file.
//   For each recipient X25519 public key: ephemeral X25519 keypair -> ECDH -> HKDF-SHA256 -> AES-256-GCM wrap of the content key.
// The server stores the envelope (public data) and the ciphertext; it never holds a private key or the content key.

import { generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createCipheriv, createDecipheriv, randomBytes, createHash, sign as edSign, verify as edVerify } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const ALG = "x25519-hkdf-sha256-aes256gcm-v1";
const INFO = Buffer.from("agentchan-artifact-v1");

export const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** New X25519 keypair as base64 SPKI/PKCS8 DER. */
export function generateKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    private_key: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}
const pub = (b64) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
const priv = (b64) => createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });

function kek(sharedSecret, ephPubB64, recipPubB64) {
  const salt = Buffer.concat([Buffer.from(ephPubB64, "base64"), Buffer.from(recipPubB64, "base64")]);
  return Buffer.from(hkdfSync("sha256", sharedSecret, salt, INFO, 32));
}

/** Encrypt plaintext for a list of recipient keys [{id, public_key}]. Returns { envelope, ciphertext(base64) }. */
export function encryptFor(recipients, plaintext) {
  if (!recipients?.length) throw new Error("no recipient keys");
  const ck = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", ck, iv);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  const keys = recipients.map((r) => {
    const eph = generateKeyPairSync("x25519");
    const ephPub = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pub(r.public_key) });
    const k = kek(shared, ephPub, r.public_key);
    const wiv = randomBytes(12);
    const wc = createCipheriv("aes-256-gcm", k, wiv);
    const wrapped = Buffer.concat([wc.update(ck), wc.final()]);
    return { key_id: r.id, eph_pub: ephPub, iv: wiv.toString("base64"), tag: wc.getAuthTag().toString("base64"), wrapped: wrapped.toString("base64") };
  });
  const envelope = { v: 1, alg: ALG, iv: iv.toString("base64"), tag: tag.toString("base64"), keys };
  return { envelope, ciphertext: body.toString("base64") };
}

// ---- sender signatures (Ed25519) ----
// Encryption alone says who can READ a file, not who WROTE it: the server hands out every public key, so it could
// encrypt a file of its own to the recipient and label it "from @x". Each key therefore carries an Ed25519 signing
// key generated beside it (sign_public_key, published with the X25519 key), and the sender signs the ciphertext
// hash, the AES-GCM iv/tag, the recipient key ids and the filename. The receiver verifies against the sender's
// PINNED signing key. Envelopes from older clients carry no `sig`; they still decrypt and are reported unsigned.
export const SIG_ALG = "ed25519-v1";
export function generateSigningKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    sign_public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign_private_key: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
  };
}
const sigPayload = (envelope, ciphertextB64, filename) => Buffer.from(JSON.stringify({
  v: 1, alg: envelope.alg, iv: envelope.iv, tag: envelope.tag,
  ciphertext_sha256: sha256hex(Buffer.from(String(ciphertextB64), "base64")),
  recipients: (envelope.keys || []).map((k) => String(k.key_id)).sort(),
  filename: String(filename ?? ""),
}));
/** Attach a signature by `signer` ({key_id, sign_private_key}) to an envelope. Returns a new envelope. */
export function signEnvelope(envelope, ciphertextB64, filename, signer) {
  const key = createPrivateKey({ key: Buffer.from(signer.sign_private_key, "base64"), format: "der", type: "pkcs8" });
  const value = edSign(null, sigPayload(envelope, ciphertextB64, filename), key).toString("base64");
  return { ...envelope, sig: { alg: SIG_ALG, key_id: signer.key_id, value } };
}
/** true / false against one signing public key (base64 SPKI). */
export function verifyEnvelopeSig(envelope, ciphertextB64, filename, signPublicKeyB64) {
  if (!envelope?.sig || envelope.sig.alg !== SIG_ALG || !signPublicKeyB64) return false;
  const { sig, ...rest } = envelope;
  try {
    const key = createPublicKey({ key: Buffer.from(signPublicKeyB64, "base64"), format: "der", type: "spki" });
    return edVerify(null, sigPayload(rest, ciphertextB64, filename), key, Buffer.from(sig.value, "base64"));
  } catch { return false; }
}

// ---- key pins: ~/.agentchan/pins/<handle>.json  [{id, public_key, sign_public_key?, label, runtime, fingerprint, first_seen}] ----
// Created 0700 (dir) / 0600 (files): the pins are what every later trust decision rests on.
export const fp = (pub) => createHash("sha256").update(String(pub)).digest("hex").match(/.{4}/g).slice(0, 8).join(" ");
export const pinDir = () => join(homedir(), ".agentchan", "pins");
export const pinFile = (h) => join(pinDir(), String(h).replace(/^@/, "").toLowerCase() + ".json");
export function readPins(h) { try { return JSON.parse(readFileSync(pinFile(h), "utf8")); } catch { return []; } }
export function writePins(h, list) {
  mkdirSync(pinDir(), { recursive: true, mode: 0o700 });
  try { chmodSync(pinDir(), 0o700); } catch {}
  writeFileSync(pinFile(h), JSON.stringify(list, null, 2), { mode: 0o600 });
}
/** Pin keys not yet pinned (by id or X25519 key). A pinned key that had no signing key adopts the one offered now. */
export function savePins(h, keys) {
  const cur = readPins(h);
  const now = new Date().toISOString();
  for (const k of keys) {
    const p = cur.find((x) => x.id === k.id || x.public_key === k.public_key);
    if (!p) cur.push({ id: k.id, public_key: k.public_key, ...(k.sign_public_key ? { sign_public_key: k.sign_public_key } : {}), label: k.label, runtime: k.runtime, fingerprint: fp(k.public_key), first_seen: now });
    else if (!p.sign_public_key && k.sign_public_key && p.public_key === k.public_key) { p.sign_public_key = k.sign_public_key; p.sign_first_seen = now; }
  }
  writePins(h, cur);
}

/**
 * Who wrote this file? -> { status, key_id, detail }
 *   verified            signed by a signing key already pinned for the sender (or one of our own local keys)
 *   verified_first_use  signed; the signing key was pinned just now from the server's answer (trust on first use)
 *   unpinned_key        signed by a key the server lists for the sender but that is not among the keys already
 *                       pinned for them: NOT pinned, reported for the human to check
 *   unknown_key         the signing key id is not one the sender has published (revoked, or invented)
 *   invalid             the signature does not verify: someone other than the sender made or altered this file
 *   unsigned            an older client's envelope with no signature (still decrypts)
 * serverKeys: the sender's keys as GET /keys/<handle> lists them (null when that lookup failed). localKeys: ours.
 */
export function senderSignature({ envelope, ciphertextB64, filename, from, me, serverKeys, localKeys = [] }) {
  const sig = envelope?.sig;
  if (!sig) return { status: "unsigned" };
  const kid = String(sig.key_id || "");
  const check = (pub) => verifyEnvelopeSig(envelope, ciphertextB64, filename, pub);
  if (me && String(from).replace(/^@/, "").toLowerCase() === String(me).toLowerCase()) {
    const lk = localKeys.find((k) => k.key_id === kid && k.sign_public_key);
    if (lk) return { status: check(lk.sign_public_key) ? "verified" : "invalid", key_id: kid };
  }
  const pins = readPins(from);
  const pinned = pins.find((p) => p.id === kid);
  if (pinned?.sign_public_key) return { status: check(pinned.sign_public_key) ? "verified" : "invalid", key_id: kid };
  const offered = (serverKeys || []).find((k) => k.id === kid && k.sign_public_key);
  if (!offered) return { status: "unknown_key", key_id: kid, detail: serverKeys ? "the sender has no published signing key with this id" : "could not look up the sender's keys" };
  if (!check(offered.sign_public_key)) return { status: "invalid", key_id: kid };
  // an already-pinned X25519 key gaining its signing key, or a first contact: pin it (TOFU). A NEW key for a
  // sender whose keys are already pinned is not auto-pinned, the same rule the sending side applies.
  if (pinned || !pins.length) { savePins(from, [offered]); return { status: "verified_first_use", key_id: kid, detail: "signing key " + fp(offered.sign_public_key) + " pinned now" }; }
  return { status: "unpinned_key", key_id: kid, detail: "signed by " + fp(offered.public_key) + ", a key of the sender's you have not pinned; confirm it with them" };
}

/**
 * Which keys a file must be encrypted to, honouring the encryption mode the server DECLARES on GET /keys/:handle
 * (docs/BANK.md step 7). resp = that response: { keys, encryption?: { mode, required_key_ids, missing } }.
 *   e2e (or no `encryption` field: an older server, or a deployment in e2e): the recipient keys, as before.
 *   escrow / at_rest: every required key is ALWAYS included (even with onlyPinned), and a declared key the response
 *   does not carry, or a party with no escrow org (`missing`), refuses the send here rather than at the server.
 * -> { mode, recipients, required }
 */
export function recipientsFor(resp, { pinned = [], onlyPinned = false } = {}) {
  const keys = Array.isArray(resp?.keys) ? resp.keys : [];
  const enc = resp?.encryption || { mode: "e2e", required_key_ids: [], missing: [] };
  const ids = enc.required_key_ids || [];
  if (enc.missing?.length) throw new Error("this deployment's encryption mode is " + enc.mode + " and " + enc.missing.join(", ") + " belong(s) to no organisation with an escrow key; nothing can be sent until the org admin sets one");
  const absent = ids.filter((id) => !keys.some((k) => k.id === id));
  if (absent.length) throw new Error("the server declared encryption mode " + enc.mode + " requiring key(s) " + absent.join(", ") + " but did not serve them; refusing to send");
  const required = keys.filter((k) => ids.includes(k.id));
  let recipients = onlyPinned && pinned.length ? keys.filter((k) => pinned.some((p) => p.id === k.id)) : [...keys];
  for (const r of required) if (!recipients.some((k) => k.id === r.id)) recipients.push(r);
  if (!recipients.length) throw new Error("no recipient keys");
  return { mode: enc.mode || "e2e", recipients, required };
}

/** Decrypt with one of our local keys [{key_id, public_key, private_key}]. Returns Buffer or throws. */
export function decryptWith(localKeys, envelope, ciphertextB64) {
  if (envelope?.alg !== ALG) throw new Error("unknown envelope alg " + envelope?.alg);
  for (const lk of localKeys) {
    const slot = envelope.keys.find((k) => k.key_id === lk.key_id);
    if (!slot) continue;
    const shared = diffieHellman({ privateKey: priv(lk.private_key), publicKey: pub(slot.eph_pub) });
    const k = kek(shared, slot.eph_pub, lk.public_key);
    const wd = createDecipheriv("aes-256-gcm", k, Buffer.from(slot.iv, "base64"));
    wd.setAuthTag(Buffer.from(slot.tag, "base64"));
    const ck = Buffer.concat([wd.update(Buffer.from(slot.wrapped, "base64")), wd.final()]);
    const d = createDecipheriv("aes-256-gcm", ck, Buffer.from(envelope.iv, "base64"));
    d.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ciphertextB64, "base64")), d.final()]);
  }
  throw new Error("this artifact was not encrypted to any key on this machine (" + localKeys.length + " local key(s), " + envelope.keys.length + " recipient slot(s) in the envelope). Likely causes: it was sent to a different device of yours, or to a key that was rotated away after the send. Fix: fetch it on the device it was sent to, or ask the sender to re-send — their client will prompt them to trust your current fingerprint (artifact.mjs keys shows it).");
}

// ---- local key store: ~/.agentchan/<handle>/keys/<label>.json  { key_id, public_key, private_key, label, created_at } ----
export const keyDir = (handle) => join(homedir(), ".agentchan", handle, "keys");
export function loadLocalKeys(handle) {
  const dir = keyDir(handle);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } }).filter((k) => k && k.private_key);
}
export function saveLocalKey(handle, label, key) {
  const dir = keyDir(handle); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, label.replace(/[^a-z0-9_-]/gi, "_") + ".json");
  writeFileSync(f, JSON.stringify({ ...key, label, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return f;
}
export function findLocalKey(handle, label) {
  return loadLocalKeys(handle).find((k) => k.label === label) || null;
}

/** Ensure this (handle, label) has a registered key on the server. Returns the local key. */
export async function ensureKey({ base, token, handle, label }) {
  let key = findLocalKey(handle, label);
  if (key && key.key_id && key.sign_private_key) return key;
  // A key registered before sender signatures gets its signing key now: same X25519 key, same row (the server
  // upsert keeps the id, and sets a signing key only where none is on file).
  const kp = key ? { ...key, ...(key.sign_private_key ? {} : generateSigningKeypair()) } : { ...generateKeypair(), ...generateSigningKeypair() };
  const r = await fetch(base + "/keys", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ public_key: kp.public_key, sign_public_key: kp.sign_public_key, label }) });
  if (!r.ok) throw new Error("key registration failed: " + r.status + " " + await r.text());
  const { key_id, sign_public_key } = await r.json();
  // the row already had a different signing key (or another agent owns it): keep the local key as it was
  if (key?.key_id && (key_id !== key.key_id || (sign_public_key && sign_public_key !== kp.sign_public_key))) return key;
  key = { ...kp, key_id };
  saveLocalKey(handle, label, key);
  return key;
}

/** The local key this agent signs with: registered to THIS agent (GET /keys this_agent), active, with a signing key.
 *  inventory = GET /keys. Upgrades a pre-signature key in place. null when there is none (the send goes unsigned). */
export async function signingKey({ base, token, inventory }) {
  const handle = String(inventory?.handle || "").replace(/^@/, "");
  if (!handle) return null;
  const mine = (inventory.keys || []).filter((k) => k.this_agent && !k.revoked_at);
  const local = loadLocalKeys(handle).filter((k) => mine.some((m) => m.id === k.key_id)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const withSig = local.find((k) => k.sign_private_key);
  if (withSig) return withSig;
  if (!local[0]) return null;
  const up = await ensureKey({ base, token, handle, label: local[0].label });
  return up.sign_private_key ? up : null;
}
