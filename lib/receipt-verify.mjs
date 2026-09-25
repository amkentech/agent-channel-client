// Offline verification of authorization receipts and Human-Authored declarations (docs/RECEIPTS.md "Wire contract").
//
// The client package cannot import the server's src/, so the three algorithms a receipt depends on are reproduced
// here byte-for-byte:
//   canonJson            src/signing.js    (sorted keys, no whitespace, JSON.stringify semantics)
//   leafHash / nodeHash  src/disclosure.js (sha256("acdf1|" + canonJson({k,v}) + "|" + salt); sha256(l + "|" + r))
//   globToRegex/pathAllowed src/contracts.js (grant path globs)
// test/receipt-verify-crosscheck.test.mjs runs both implementations on generated data so they cannot drift apart.
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";

export const MERKLE_WIDTH = 16;
const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** Deterministic JSON, identical to src/signing.js canonJson. */
export function canonJson(v) {
  if (v === null || v === undefined || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v.toJSON === "function") return canonJson(v.toJSON());
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonJson(x))).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
}

export const leafHash = (k, v, salt) => sha256hex("acdf1|" + canonJson({ k, v }) + "|" + salt);
export const nodeHash = (l, r) => sha256hex(l + "|" + r);

/** Walk a fact's proof to the root, exactly as src/disclosure.js verifyLeaf. */
export function verifyLeaf(fact, root) {
  let h = leafHash(fact.k, fact.v, fact.salt);
  for (const step of fact.proof || []) h = step.side === "right" ? nodeHash(h, step.h) : nodeHash(step.h, h);
  return h === root;
}

/** Grant/scope path globs, identical to src/contracts.js. Case-insensitive; ** crosses directories, * does not. */
export function globToRegex(glob) {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (".+^${}()|[]\\".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(re + "$", "i");
}
export const pathAllowed = (path, patterns) => !patterns?.length || patterns.some((g) => globToRegex(g).test(path) || (path.endsWith("/**") ? globToRegex(g).test(path.slice(0, -3)) && g.endsWith("**") : false) || g === path);

/** Digest + Ed25519 signature over a signBody() wrapper. Returns { ok, why }. */
export function verifySignedWrapper(wrapped, publicKeyPem) {
  if (!wrapped || typeof wrapped !== "object" || !wrapped.body) return { ok: false, why: "not a signed wrapper ({ body, digest_sha256, signature })" };
  const digest = sha256hex(canonJson(wrapped.body));
  if (digest !== wrapped.digest_sha256) return { ok: false, why: "digest mismatch: the signed body was altered" };
  if (!wrapped.signature?.sig) return { ok: false, why: "unsigned (the server had no signing key); an unsigned receipt proves nothing" };
  if (!publicKeyPem) return { ok: false, why: "no public key to verify the signature against" };
  let ok = false;
  try { ok = edVerify(null, Buffer.from(digest, "hex"), createPublicKey(publicKeyPem), Buffer.from(wrapped.signature.sig, "base64url")); }
  catch (e) { return { ok: false, why: "signature check failed: " + e.message }; }
  return ok ? { ok: true, kid: wrapped.signature.kid } : { ok: false, why: "signature does not verify with the public key" };
}

/** Group facts by key. A key may repeat (e.g. `attested` one per human); single-valued keys take the first. */
export function factsByKey(facts) {
  const m = {};
  for (const f of facts || []) (m[f.k] ||= []).push(f.v);
  return m;
}

/**
 * Verify a receipt document offline. `expect` = { receipt_id?, root? } from the trailer.
 * Returns { ok, problems: [..], body, facts: {k: [v..]}, binding, scope }.
 */
export function verifyReceiptDoc(doc, publicKeyPem, expect = {}) {
  const problems = [];
  const body = doc?.body;
  if (!body || body.format !== "agentchan-receipt-v1") return { ok: false, problems: ["not an agentchan-receipt-v1 document"], body };
  if (expect.receipt_id && body.receipt_id !== expect.receipt_id) problems.push("receipt id mismatch: trailer names " + expect.receipt_id + ", document is " + body.receipt_id);
  if (expect.root && String(body.root).toLowerCase() !== String(expect.root).toLowerCase()) problems.push("root mismatch: trailer root " + String(expect.root).slice(0, 16) + "… is not the signed root " + String(body.root).slice(0, 16) + "…");
  const sig = verifySignedWrapper(doc, publicKeyPem);
  if (!sig.ok) problems.push(sig.why);
  const facts = Array.isArray(body.facts) ? body.facts : [];
  if (!facts.length) problems.push("receipt carries no facts");
  if (facts.length > MERKLE_WIDTH) problems.push("more facts than the tree width " + MERKLE_WIDTH);
  if (body.merkle?.width && body.merkle.width !== MERKLE_WIDTH) problems.push("unexpected Merkle width " + body.merkle.width);
  for (const f of facts) if (!verifyLeaf(f, body.root)) problems.push("fact '" + f.k + "' does not prove to the signed root");
  const byKey = factsByKey(facts);
  const binding = byKey.binding?.[0] ?? null;
  const scope = byKey.scope?.[0] ?? null;
  if (!binding || !Array.isArray(binding.commits)) problems.push("receipt has no binding fact (repo + commits)");
  return { ok: problems.length === 0, problems, body, facts: byKey, binding, scope, kid: sig.kid };
}

/** Verify a Human-Authored declaration document offline. */
export function verifyDeclarationDoc(doc, publicKeyPem, expect = {}) {
  const problems = [];
  const body = doc?.body;
  if (!body || body.format !== "agentchan-declaration-v1") return { ok: false, problems: ["not an agentchan-declaration-v1 document"], body };
  if (expect.declaration_id && body.declaration_id !== expect.declaration_id) problems.push("declaration id mismatch: trailer names " + expect.declaration_id + ", document is " + body.declaration_id);
  const sig = verifySignedWrapper(doc, publicKeyPem);
  if (!sig.ok) problems.push(sig.why);
  if (!Array.isArray(body.commits) || !body.commits.length) problems.push("declaration names no commits");
  if (!body.person) problems.push("declaration names no person");
  return { ok: problems.length === 0, problems, body, kid: sig.kid };
}

/** Does a binding/commits list name this commit, by sha or by stable patch-id? Returns the entry or null. */
export function findCommitEntry(commits, sha, patchId) {
  for (const e of commits || []) {
    if (e.sha && sha && String(e.sha).toLowerCase() === String(sha).toLowerCase()) return { entry: e, by: "sha" };
  }
  for (const e of commits || []) {
    if (e.patch_id && patchId && String(e.patch_id).toLowerCase() === String(patchId).toLowerCase()) return { entry: e, by: "patch-id" };
  }
  return null;
}

/** Revocation rule from the wire contract: valid iff revoked_at is null or later than issued_at. */
export function revocationValid(status, issuedAt) {
  if (!status?.revoked_at) return { ok: true };
  const r = Date.parse(status.revoked_at), i = Date.parse(issuedAt);
  if (Number.isNaN(r) || Number.isNaN(i)) return { ok: false, why: "unparseable revoked_at/issued_at (" + status.revoked_at + " / " + issuedAt + ")" };
  return r > i ? { ok: true, note: "authorization revoked at " + status.revoked_at + ", after this receipt was issued; revocation stops future work, not this" }
    : { ok: false, why: "authorization revoked at " + status.revoked_at + ", not after this receipt was issued at " + issuedAt };
}

/** A scope repo entry covers a normalised binding repo: the same rule as src/receipts.js repoInScope. Equal, or the
 *  entry names no host ("owner/name", "org/proj/repo") and equals the repo with its host removed. Not a suffix match:
 *  "name" alone or "proj/repo" under an Azure org must not cover a repo the server would refuse to mint for. */
export function repoInScope(repo, repos) {
  if (!repos?.length) return true;
  const r = String(repo || "").toLowerCase();
  const hasHost = (x) => x.split("/").length >= 3 && (x.split("/")[0].includes(".") || x.split("/")[0] === "localhost");
  return repos.some((s) => {
    const x = String(s).toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
    return r === x || (!hasHost(x) && hasHost(r) && r.split("/").slice(1).join("/") === x);
  });
}

/** Load a JSON document from a file path or an http(s) URL. */
export async function loadJson(src, { timeoutMs = 10000 } = {}) {
  if (/^https?:\/\//i.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status + " from " + src);
    return await r.json();
  }
  let d = JSON.parse(readFileSync(src, "utf8"));
  if (d?.content?.[0]?.text) d = JSON.parse(d.content[0].text); // raw MCP tool result
  return d;
}

/**
 * The public key: pinned from a PEM file, or fetched from the server's well-known URL (and said so loudly).
 * Returns { pem, pinned, from, error }.
 */
export async function resolvePublicKey({ publicKeyFile, server, timeoutMs = 10000 } = {}) {
  if (publicKeyFile) {
    try { return { pem: readFileSync(publicKeyFile, "utf8"), pinned: true, from: publicKeyFile }; }
    catch (e) { return { pem: null, pinned: true, from: publicKeyFile, error: "cannot read --public-key " + publicKeyFile + ": " + e.message }; }
  }
  const url = String(server || "https://channel.amkentech.com").replace(/\/mcp$/, "").replace(/\/$/, "") + "/.well-known/agentchan-signing-key.json";
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json();
    if (!j.public_key_pem) return { pem: null, pinned: false, from: url, error: "server publishes no signing key (" + (j.note || "no public_key_pem") + ")" };
    return { pem: j.public_key_pem, pinned: false, from: url + " (kid " + j.kid + ")" };
  } catch (e) { return { pem: null, pinned: false, from: url, error: "could not fetch the public key from " + url + ": " + e.message }; }
}
export const NOT_PINNED_NOTE = "public key NOT pinned: fetched from the same server that signed, which proves only that this server signed it; pass --public-key <pem> to pin it out of band";
