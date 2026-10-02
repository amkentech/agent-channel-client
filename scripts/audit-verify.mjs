#!/usr/bin/env node
// Offline verifier for Agent Channel exports. No database access; optionally one fetch for the public key.
//   node scripts/audit-verify.mjs export.json                       audit_trail mode=export (signed wrapper or bare)
//   node scripts/audit-verify.mjs --record record.json               export_contract / GET /c/:id/record.json
//   node scripts/audit-verify.mjs --disclosure disclosure.json        disclose_contract / GET /c/:id/disclosure.json (any subset of facts)
//   node scripts/audit-verify.mjs --receipt <file|url>               GET /receipts/<id>.json (signature, digest, every fact's proof)
//   node scripts/audit-verify.mjs --declaration <file|url>           GET /declarations/<id>.json (signature, digest)
//   node scripts/audit-verify.mjs --anchors <file|url> [--tsa-root pem] [--rekor-key pem] [--export export.json]
//                                                                    GET /ledger/anchors: RFC 3161 tokens + Rekor entries, offline
//   node scripts/audit-verify.mjs --play export.json                 play_trail mode=export: the PLAY chain (duels, quests)
//   node scripts/audit-verify.mjs --anchors <file|url> --play        GET /ledger/anchors?chain=play
//   options: --pubkey|--public-key <pem file> | --pubkey-url <url> (default: the server named in the export), --no-sig (skip signature)
// Checks: every ledger row's hash from its canonical string, every visible chain link, and (if present) the server's Ed25519
// signature over the sha256 of the canonical JSON body, against a public key you supply or fetch. Pin the key out of band
// if this matters to you: a key fetched from the same server proves only that the server signed it.
import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const file = args.find((a, i) => !a.startsWith("--") && !["--pubkey", "--pubkey-url", "--public-key", "--server", "--tsa-root", "--rekor-key", "--export"].includes(args[i - 1]));
// Two chains share one canonical form (src/audit.js canonical): `audit`, the authorization record, and `play`, duels and
// quests (src/play.js). --play says which one this file must be, so a play export can never pass as authorization
// evidence and an audit export can never be read as a game record.
const PLAY = args.includes("--play");
if (!file) { console.error("usage: audit-verify.mjs [--record|--disclosure|--receipt|--declaration|--anchors] [--play] <file.json|url> [--pubkey file.pem | --public-key file.pem | --pubkey-url url | --no-sig]\n       audit-verify.mjs --anchors <anchors.json|https://server/ledger/anchors> [--tsa-root root.pem ...] [--rekor-key key.pem ...] [--export audit-export.json]"); process.exit(1); }

// ---- external anchors (GET /ledger/anchors; docs/VERIFY.md "External anchors") ----
// Offline except for fetching the listing when given a URL. Every RFC 3161 token: messageImprint == the anchored head
// hash, the TSA's signature over the signed attributes, the signing-certificate attribute, the chain to a PINNED root
// (lib/anchor-roots/, plus any --tsa-root), all valid at genTime. Every Rekor entry: the logged hash, the RFC 6962
// inclusion proof to the checkpoint's root, the checkpoint's signature and the signed entry timestamp, against the
// pinned log key (plus any --rekor-key). With --export, each anchored head is tied to the recomputed ledger row.
if (args.includes("--anchors")) {
  const av = await import("../lib/anchor-verify.mjs");
  const rv = await import("../lib/receipt-verify.mjs");
  const all = (k) => args.flatMap((a, i) => (a === k && args[i + 1] ? [args[i + 1]] : []));
  const roots = av.bundledRoots();
  for (const f of all("--tsa-root")) roots.tsa.push({ name: f, pem: readFileSync(f, "utf8") });
  for (const f of all("--rekor-key")) roots.rekor.push({ name: f, pem: readFileSync(f, "utf8") });
  console.log("pinned TSA roots: " + roots.tsa.map((r) => r.name).join("; "));
  console.log("pinned Rekor keys: " + roots.rekor.map((r) => r.name).join("; "));
  let anchors = [], listing;
  const want = PLAY ? "play" : "audit";
  let src = file;
  if (/^https?:\/\//i.test(file) && PLAY) { const u = new URL(file); if (!u.searchParams.get("chain")) u.searchParams.set("chain", "play"); src = u.toString(); }
  try {
    listing = await rv.loadJson(src);
    anchors.push(...(listing.anchors || []));
    // a URL listing pages by after_id; follow it (bounded)
    for (let p = 0; /^https?:\/\//i.test(src) && listing.next_after_id && p < 100; p++) {
      const u = new URL(src); u.searchParams.set("after_id", listing.next_after_id);
      listing = await rv.loadJson(u.toString());
      anchors.push(...(listing.anchors || []));
    }
  } catch (e) { console.error("cannot read " + file + ": " + e.message); process.exit(1); }
  // an anchor row with no chain predates the play chain: it is an audit anchor
  const other = anchors.filter((a) => (a.chain || "audit") !== want).length;
  anchors = anchors.filter((a) => (a.chain || "audit") === want);
  console.log("chain: " + want + (other ? " (" + other + " anchor(s) for another chain ignored)" : ""));
  if (!anchors.length) { console.log("no " + want + "-chain anchors in this listing"); process.exit(1); }
  let rowsBySeq = null;
  if (opt("--export")) {
    let ex = JSON.parse(readFileSync(opt("--export"), "utf8"));
    if (ex.content?.[0]?.text) ex = JSON.parse(ex.content[0].text);
    const b = ex.body || ex;
    rowsBySeq = new Map((b.entries || b.timeline || []).map((e) => [Number(e.seq), e]));
  }
  const canonRow = (e) => e.canonical ?? ((e.prev_hash ?? "") + "|" + String(e.seq) + "|" + e.at_canon + "|" + (e.actor_person ?? "") + "|" + (e.actor_agent ?? "") + "|" + (e.subject_person ?? "") + "|" + e.action + "|" + (e.object_type ?? "") + "|" + (e.object_id ?? "") + "|" + e.payload_text + (e.policy_version ? "|pv:" + e.policy_version : ""));
  let bad = 0;
  const good = [];
  for (const a of anchors.sort((x, y) => Number(x.head_seq) - Number(y.head_seq) || Number(x.id) - Number(y.id))) {
    const r = await av.verifyAnchor({ kind: a.kind, head_hash: a.head_hash, proof: a.proof }, roots);
    const who = a.kind === "rfc3161" ? (r.tsa || a.proof?.tsa || a.anchor_name) + " (RFC 3161)" : "Rekor " + (a.endpoint || "") + " logIndex " + (r.logIndex ?? a.proof?.entry?.logIndex);
    const when = a.kind === "rfc3161" ? r.genTime : r.integratedTime;
    let tie = "";
    if (rowsBySeq) {
      const e = rowsBySeq.get(Number(a.head_seq));
      if (!e) tie = "; seq " + a.head_seq + " not in the export";
      else {
        const h = createHash("sha256").update(canonRow(e), "utf8").digest("hex");
        if (h !== e.hash || e.hash !== a.head_hash) { r.problems.push("export row seq " + a.head_seq + " does not recompute to the anchored hash"); r.ok = false; }
        else tie = "; export row seq " + a.head_seq + " recomputes to it";
      }
    }
    if (!r.ok) bad++; else good.push({ seq: Number(a.head_seq), who, when });
    console.log((r.ok ? "anchor ok  " : "ANCHOR FAIL") + "  seq <= " + a.head_seq + "  " + String(a.head_hash).slice(0, 16) + "…  " + a.anchor_name + ": " + who + " at " + (when || "?") + tie);
    if (r.chain?.length) console.log("    chain: " + r.chain.join(" <- "));
    for (const p of r.problems || []) console.log("    PROBLEM: " + p);
  }
  // Coverage: an anchor on head N countersigns every row up to N (each row's hash is folded into the next).
  const seqs = [...new Set(good.map((g) => g.seq))].sort((x, y) => x - y);
  console.log("\ncoverage (a head's anchor covers every row at or before it, as that chain stood at that time):");
  let lo = 1;
  for (const s of seqs) {
    const by = good.filter((g) => g.seq === s).sort((x, y) => String(x.when).localeCompare(String(y.when)));
    console.log("  rows seq " + lo + ".." + s + ": first anchored " + by[0].when + "; by " + by.map((g) => g.who + " @ " + g.when).join(", "));
    lo = s + 1;
  }
  if (seqs.length) console.log("  rows after seq " + seqs.at(-1) + ": NOT anchored yet (protected only once the next anchor lands)");
  console.log(bad ? "FAIL: " + bad + " anchor(s) did not verify" : "OK: " + good.length + " anchor(s) verified against outside parties' keys");
  process.exit(bad ? 2 : 0);
}

// ---- authorization receipts and Human-Authored declarations (docs/RECEIPTS.md "Wire contract") ----
// Offline: digest, Ed25519 signature, and (receipts) every fact's salted Merkle proof to the signed root. The key is
// pinned with --public-key/--pubkey; otherwise it is fetched from --pubkey-url or the server (--server, default the
// live one) and the output says it was NOT pinned. The revocation question is online and belongs to `receipt check`.
if (args.includes("--receipt") || args.includes("--declaration")) {
  const rv = await import("../lib/receipt-verify.mjs");
  let d;
  try { d = await rv.loadJson(file); } catch (e) { console.error("cannot read " + file + ": " + e.message); process.exit(1); }
  const isReceipt = args.includes("--receipt");
  const pinnedFile = opt("--public-key") || opt("--pubkey");
  let pem = null;
  if (args.includes("--no-sig")) console.log("signature check skipped (--no-sig): only the digest and proofs below mean anything");
  else if (pinnedFile) { const k = await rv.resolvePublicKey({ publicKeyFile: pinnedFile }); pem = k.pem; console.log(k.error ? k.error : "public key pinned: " + k.from); }
  else if (opt("--pubkey-url")) {
    try { const j = await (await fetch(opt("--pubkey-url"), { signal: AbortSignal.timeout(10000) })).json(); pem = j.public_key_pem; console.log(rv.NOT_PINNED_NOTE + " (" + opt("--pubkey-url") + ")"); }
    catch (e) { console.log("could not fetch the public key (" + e.message + ")"); }
  } else {
    const fromUrl = /^https?:\/\//i.test(file) ? new URL(file).origin : null;
    const k = await rv.resolvePublicKey({ server: opt("--server") || fromUrl || process.env.AGENTCHAN_URL });
    pem = k.pem; console.log(k.error ? k.error : rv.NOT_PINNED_NOTE + " (" + k.from + ")");
  }
  const res = isReceipt ? rv.verifyReceiptDoc(d, pem) : rv.verifyDeclarationDoc(d, pem);
  const problems = args.includes("--no-sig") ? res.problems.filter((p) => !/signature|public key|unsigned/.test(p)) : res.problems;
  const b = res.body || {};
  if (isReceipt && b.format) {
    const n = Array.isArray(b.facts) ? b.facts.length : 0;
    console.log("receipt " + b.receipt_id + " issued " + b.issued_at + ", root " + String(b.root).slice(0, 16) + "…, " + n + " fact(s): " + (b.facts || []).map((f) => f.k).join(", "));
    if (res.binding) console.log("  binding: " + res.binding.repo + ", " + (res.binding.commits || []).length + " commit(s): " + (res.binding.commits || []).map((c) => String(c.sha).slice(0, 12) + " [" + (c.paths || []).length + " path(s)]").join(", "));
    if (res.scope) console.log("  scope: repos " + JSON.stringify(res.scope.repos || []) + ", paths " + JSON.stringify(res.scope.paths || []) + (res.scope.expires_at ? ", expires " + res.scope.expires_at : ""));
  } else if (b.format) console.log("declaration " + b.declaration_id + " by " + b.person + " issued " + b.issued_at + " for " + b.repo + ", " + (b.commits || []).length + " commit(s)");
  for (const p of problems) console.log("PROBLEM: " + p);
  console.log(problems.length ? "FAIL: " + problems.length + " problem(s)" : "OK" + (isReceipt ? " (signature, digest, and every fact's proof; revocation is checked online by `agent-channel receipt check`)" : " (signature and digest)"));
  process.exit(problems.length ? 2 : 0);
}
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
const isPlay = body.format === "agentchan-play-export-v1" || body.chain === "play";
if (PLAY && !isPlay) { console.error("--play: this is not a play-chain export (format " + JSON.stringify(body.format ?? null) + "); play_trail mode=export produces one"); process.exit(1); }
if (!PLAY && isPlay) console.log("note: this is a PLAY-chain export (duels, quests), not the authorization record; pass --play to assert that");
console.log("chain: " + (isPlay ? "play" : "audit"));

// ---- 1. ledger rows (audit export: body.entries; contract record: body.timeline has hash+prev_hash but no canonical) ----
const canonJson = (v) => v === null || v === undefined || typeof v !== "object" ? JSON.stringify(v === undefined ? null : v) : v instanceof Date ? JSON.stringify(v.toISOString()) : Array.isArray(v) ? "[" + v.map((x) => (x === undefined ? "null" : canonJson(x))).join(",") + "]" : "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonJson(v[k])).join(",") + "}";
const canonical = (e) => e.canonical ?? ((e.prev_hash ?? "") + "|" + String(e.seq) + "|" + e.at_canon + "|" + (e.actor_person ?? "") + "|" + (e.actor_agent ?? "") + "|" + (e.subject_person ?? "") + "|" + e.action + "|" + (e.object_type ?? "") + "|" + (e.object_id ?? "") + "|" + e.payload_text + (e.policy_version ? "|pv:" + e.policy_version : ""));
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
