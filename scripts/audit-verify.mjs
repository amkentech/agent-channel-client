#!/usr/bin/env node
// Offline verifier for Agent Channel exports. No database access; optionally one fetch for the public key.
//   node scripts/audit-verify.mjs export.json                       audit_trail mode=export (signed wrapper or bare)
//   node scripts/audit-verify.mjs --record record.json               export_contract / GET /c/:id/record.json
//   node scripts/audit-verify.mjs --disclosure disclosure.json        disclose_contract / GET /c/:id/disclosure.json (any subset of facts)
//   options: --pubkey <pem file> | --pubkey-url <url> (default: the server named in the export), --no-sig (skip signature)
// Checks: every ledger row's hash from its canonical string, every visible chain link, and (if present) the server's Ed25519
// signature over the sha256 of the canonical JSON body, against a public key you supply or fetch. Pin the key out of band
// if this matters to you: a key fetched from the same server proves only that the server signed it.
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--pubkey" && args[i - 1] !== "--pubkey-url");
if (!file) { console.error("usage: audit-verify.mjs [--record|--disclosure] <file.json> [--pubkey file.pem | --pubkey-url url | --no-sig]"); process.exit(1); }
let doc = JSON.parse(readFileSync(file, "utf8"));
if (doc.content?.[0]?.text) doc = JSON.parse(doc.content[0].text); // raw MCP tool result

// ---- disclosure fact sheets (disclose_contract / GET /c/:id/disclosure.json) ----
// The signature covers the Merkle ROOT, not the fact list: recompute each fact's salted leaf, walk its proof to the
// root, then verify the signature over the signed body. A SUBSET of the original facts verifies identically — that
// is the point — so "OK" here means "every fact present is genuine", never "these are all the facts there were".
if (args.includes("--disclosure") || doc.signed?.body?.format === "agentchan-disclosure-v1") {
  const canonD = (v) => v === null || v === undefined || typeof v !== "object" ? JSON.stringify(v === undefined ? null : v) : Array.isArray(v) ? "[" + v.map((x) => (x === undefined ? "null" : canonD(x))).join(",") + "]" : "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonD(v[k])).join(",") + "}";
  const H = (s) => createHash("sha256").update(s, "utf8").digest("hex");
  const w = doc, root = w.signed?.body?.merkle?.root;
  let bad = 0;
  if (!root || !Array.isArray(w.facts)) { console.error("not a disclosure file: expected { signed: { body: { merkle: { root } } }, facts: [...] }"); process.exit(1); }
  for (const f of w.facts) {
    let h = H("acdf1|" + canonD({ k: f.k, v: f.v }) + "|" + f.salt);
    for (const st of f.proof || []) h = st.side === "right" ? H(h + "|" + st.h) : H(st.h + "|" + h);
    if (h !== root) { bad++; console.log("FACT FAIL: '" + f.k + "' does not prove to the signed root"); }
  }
  console.log((bad ? "FACTS FAIL" : "facts ok") + ": " + w.facts.length + " fact(s) checked against root " + root.slice(0, 16) + "… (a subset of the original sheet verifies the same; absence of a fact proves nothing)");
  const digest = createHash("sha256").update(canonD(w.signed.body)).digest("hex");
  if (digest !== w.signed.digest_sha256) { bad++; console.log("DIGEST MISMATCH: signed body altered"); }
  else if (!w.signed.signature) console.log("digest ok; no signature (server had no signing key)");
  else if (args.includes("--no-sig")) console.log("signature check skipped (--no-sig)");
  else {
    let pem = null, from = "";
    if (opt("--pubkey")) { pem = readFileSync(opt("--pubkey"), "utf8"); from = opt("--pubkey"); }
    else {
      const url = opt("--pubkey-url") || ((w.signed.body.server || "https://channel.amkentech.com").replace(/\/$/, "") + "/.well-known/agentchan-signing-key.json");
      try { const j = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json(); pem = j.public_key_pem; from = url + " (kid " + j.kid + ")"; } catch (e) { console.log("could not fetch the public key (" + e.message + "); pass --pubkey <pem> or --no-sig"); }
    }
    if (pem) {
      const ok = edVerify(null, Buffer.from(digest, "hex"), createPublicKey(pem), Buffer.from(w.signed.signature.sig, "base64url"));
      if (!ok) bad++;
      console.log((ok ? "signature ok" : "SIGNATURE FAIL") + ": Ed25519 " + w.signed.signature.kid + " signed " + w.signed.signature.signed_at + ", key from " + from);
    }
  }
  console.log(bad ? "FAIL: " + bad + " problem(s)" : "OK");
  process.exit(bad ? 2 : 0);
}
if (doc.record && doc.digest_sha256 === undefined && doc.signature) doc = { body: doc.record, digest_sha256: doc.digest_sha256, signature: doc.signature }; // export_contract tool output
const wrapped = doc.body ? doc : null;            // signed wrapper { body, digest_sha256, signature }
const body = wrapped ? wrapped.body : doc;
let problems = 0;

// ---- 1. ledger rows (audit export: body.entries; contract record: body.timeline has hash+prev_hash but no canonical) ----
const canonJson = (v) => v === null || v === undefined || typeof v !== "object" ? JSON.stringify(v === undefined ? null : v) : v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? "[" + v.map((x) => (x === undefined ? "null" : canonJson(x))).join(",") + "]" : "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
const canonical = (e) => e.canonical ?? ((e.prev_hash ?? "") + "|" + String(e.seq) + "|" + e.at_canon + "|" + (e.actor_person ?? "") + "|" + (e.actor_agent ?? "") + "|" + (e.subject_person ?? "") + "|" + e.action + "|" + (e.object_type ?? "") + "|" + (e.object_id ?? "") + "|" + e.payload_text);
const entries = (body.entries || body.timeline || []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
if (entries.length) {
  let bad = 0, links = 0, gaps = 0, hashed = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.canonical || e.payload_text !== undefined) { hashed++; const h = createHash("sha256").update(canonical(e), "utf8").digest("hex"); if (h !== e.hash) { bad++; console.log("HASH MISMATCH seq " + e.seq + " (" + e.action + ")"); } }
    if (i > 0) { const prev = entries[i - 1]; if (Number(e.seq) === Number(prev.seq) + 1) { links++; if (e.prev_hash !== prev.hash) { bad++; console.log("BROKEN LINK " + prev.seq + " -> " + e.seq); } } else gaps++; }
  }
  problems += bad;
  console.log((bad ? "LEDGER FAIL" : "ledger ok") + ": " + entries.length + " rows, " + hashed + " hashes recomputed, " + links + " adjacent links checked, " + gaps + " gaps (other objects' rows between; expected)" + (bad ? ", " + bad + " problems" : ""));
  console.log("  range: seq " + entries[0].seq + " (" + entries[0].at + ") .. seq " + entries.at(-1).seq + " (" + entries.at(-1).at + ")" + (body.for ? " for " + body.for : body.contract ? " for contract " + body.contract.id : ""));
  if (body.chain) console.log("  server-side chain check over that range: " + (body.chain.intact === true ? "intact" : body.chain.intact === false ? "BROKEN at " + JSON.stringify(body.chain.detail) : "n/a"));
} else console.log("no ledger rows in this file");

// ---- 2. signature ----
if (wrapped && !args.includes("--no-sig")) {
  const digest = createHash("sha256").update(canonJson(wrapped.body)).digest("hex");
  if (digest !== wrapped.digest_sha256) { problems++; console.log("DIGEST MISMATCH: the body was altered after signing (computed " + digest.slice(0, 16) + "…, file says " + String(wrapped.digest_sha256).slice(0, 16) + "…)"); }
  else if (!wrapped.signature) console.log("digest ok; no signature (the server had no signing key when this was exported)");
  else {
    let pem = null, from = "";
    if (opt("--pubkey")) { pem = readFileSync(opt("--pubkey"), "utf8"); from = opt("--pubkey"); }
    else {
      const url = opt("--pubkey-url") || ((body.server || "https://channel.amkentech.com").replace(/\/$/, "") + "/.well-known/agentchan-signing-key.json");
      try { const j = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json(); pem = j.public_key_pem; from = url + " (kid " + j.kid + ")"; if (body.signing_key?.public_key_pem && body.signing_key.public_key_pem !== pem) console.log("note: the key embedded in the export differs from the one the server publishes now (rotation?)"); }
      catch (e) { console.log("could not fetch the public key (" + e.message + "); pass --pubkey <pem> or --no-sig"); }
    }
    if (pem) {
      const ok = edVerify(null, Buffer.from(digest, "hex"), createPublicKey(pem), Buffer.from(wrapped.signature.sig, "base64url"));
      if (!ok) problems++;
      console.log((ok ? "signature ok" : "SIGNATURE FAIL") + ": Ed25519 " + wrapped.signature.kid + " signed " + wrapped.signature.signed_at + ", key from " + from);
    }
  }
} else if (wrapped) console.log("signature check skipped (--no-sig)");
else console.log("unsigned export format (no wrapper); only the ledger rows were checked");

console.log(problems ? "FAIL: " + problems + " problem(s)" : "OK");
process.exit(problems ? 2 : 0);
