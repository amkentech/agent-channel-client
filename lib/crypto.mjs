// End-to-end artifact encryption. Runs on the sender's and receiver's machines only.
// Scheme (v1): random 256-bit content key -> AES-256-GCM over the file.
//   For each recipient X25519 public key: ephemeral X25519 keypair -> ECDH -> HKDF-SHA256 -> AES-256-GCM wrap of the content key.
// The server stores the envelope (public data) and the ciphertext; it never holds a private key or the content key.

import { generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
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
  throw new Error("this artifact was not encrypted to any key on this machine (" + localKeys.length + " local keys)");
}

// ---- local key store: ~/.agentchan/<handle>/keys/<label>.json  { key_id, public_key, private_key, label, created_at } ----
export const keyDir = (handle) => join(homedir(), ".agentchan", handle, "keys");
export function loadLocalKeys(handle) {
  const dir = keyDir(handle);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { return null; } }).filter((k) => k && k.private_key);
}
export function saveLocalKey(handle, label, key) {
  const dir = keyDir(handle); mkdirSync(dir, { recursive: true });
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
  if (key && key.key_id) return key;
  const kp = key || generateKeypair();
  const r = await fetch(base + "/keys", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ public_key: kp.public_key, label }) });
  if (!r.ok) throw new Error("key registration failed: " + r.status + " " + await r.text());
  const { key_id } = await r.json();
  key = { ...kp, key_id };
  saveLocalKey(handle, label, key);
  return key;
}
