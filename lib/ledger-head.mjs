// A local witness for the ledger head. The database owner can drop the triggers that refuse updates and rehash
// everything; a head the client stored on its own disk cannot be rewritten by that owner. So the client keeps the
// heads it has SEEN AND VERIFIED, and every new head must be shown to extend the last one:
//
//   1. the head is signed (Ed25519, the export key; pinned on first use per server, a change of key is an alert);
//   2. the server's consistency view (/ledger/consistency) between the stored head and the new one is walked row by
//      row: the stored head's row must still be there with the same hash, each row's prev_hash must be the previous
//      ROW's hash (seq has gaps: a rolled-back transaction consumes a number, so seq+1 means nothing), rows the
//      caller is party to arrive with their canonical string and are recomputed here, and the walk must end on the
//      new head's exact hash;
//   3. anything else is a FORK: recorded in ledger-forks.jsonl with the signed evidence, surfaced in the inbox banner
//      on every prompt until a human acknowledges it (`agent-channel ledger ack`). A skipped range of seqs is not
//      assumed benign: it is walked like any other.
// What this cannot see: a rewrite of rows the caller is not party to that keeps every hash link consistent is only a
// server claim here (the rows' content is other people's). That is what the external anchors are for
// (docs/VERIFY.md): a head countersigned by a TSA or Rekor cannot be silently replaced by a rehashed chain.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HOME_STORE } from "./paths.mjs";
import { verifySignedWrapper } from "./receipt-verify.mjs";

export const ledgerHeadFile = (dir = HOME_STORE) => join(dir, "ledger-heads.jsonl");
export const ledgerForkFile = (dir = HOME_STORE) => join(dir, "ledger-forks.jsonl");
const ackFile = (dir) => join(dir, "ledger-forks-ack.json");
const keyFile = (dir) => join(dir, "ledger-keys.json");
const stampFile = (dir) => join(dir, "ledger-check.json");
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").split(/\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

function lastFor(dir, server, { verifiedOnly = false } = {}) {
  const rows = lines(ledgerHeadFile(dir));
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if ((!server || row.server === server) && (!verifiedOnly || row.verified === true)) return row;
  }
  return null;
}
export const lastVerifiedHead = (dir, server) => lastFor(dir, server, { verifiedOnly: true });

/**
 * Append a head without asking the server anything (the first, unverified form; kept for callers that only have a
 * head). head = { seq, hash, prev_hash, at }. Returns { ok, stored, fork, gap, file }. A gap here means "not checked
 * yet", never "fine": checkLedger() is what verifies it.
 */
export function recordLedgerHead(head, dir = HOME_STORE, server = null) {
  if (!head || typeof head.hash !== "string" || !head.hash || head.seq == null || Number.isNaN(Number(head.seq))) {
    return { ok: false, why: "head needs seq and hash" };
  }
  mkdirSync(dir, { recursive: true });
  const file = ledgerHeadFile(dir);
  const seq = Number(head.seq);
  const last = lastFor(dir, server);
  if (last && last.hash === head.hash && Number(last.seq) === seq) return { ok: true, stored: false, fork: false, gap: false, file };
  const adjacent = !!(last && seq === Number(last.seq) + 1);
  const rewound = !!(last && seq < Number(last.seq));
  const fork = rewound || (adjacent && (last.hash !== (head.prev_hash ?? null)));
  const gap = !!(last && seq > Number(last.seq) + 1);
  const row = { seq, hash: head.hash, prev_hash: head.prev_hash ?? null, at: head.at ?? null, server: server ?? null, seen_at: new Date().toISOString(), fork, gap };
  appendFileSync(file, JSON.stringify(row) + "\n");
  return { ok: true, stored: true, fork, gap, file };
}

function storeVerified(dir, server, head, how, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const row = { seq: Number(head.seq), hash: head.hash, prev_hash: head.prev_hash ?? null, at: head.at ?? null, server, seen_at: new Date().toISOString(), fork: false, gap: false, verified: true, how, ...extra };
  appendFileSync(ledgerHeadFile(dir), JSON.stringify(row) + "\n");
  return row;
}

// ---------------- alerts ----------------
function recordAlert(dir, server, alert) {
  mkdirSync(dir, { recursive: true });
  const key = [server, alert.kind, alert.stored?.hash ?? "", alert.got?.hash ?? alert.got?.kid ?? ""].join("|");
  const id = sha256(key).slice(0, 16);
  if (lines(ledgerForkFile(dir)).some((a) => a.id === id)) return { id, duplicate: true };
  appendFileSync(ledgerForkFile(dir), JSON.stringify({ id, at: new Date().toISOString(), server, ...alert }) + "\n");
  return { id, duplicate: false };
}
/** Alerts not yet acknowledged by a human, oldest first (optionally for one server). */
export function ledgerAlerts(dir = HOME_STORE, server = null) {
  const acked = new Set(readJson(ackFile(dir), []));
  return lines(ledgerForkFile(dir)).filter((a) => !acked.has(a.id) && (!server || a.server === server));
}
/**
 * A human read the alert and decided. Acknowledging a fork rebases this machine's witness on the head the server now
 * shows (the old one stays in the file); acknowledging a key change pins the new key. The evidence stays in
 * ledger-forks.jsonl either way. Returns the acknowledged alerts.
 */
export function ackLedgerAlerts(dir = HOME_STORE, server = null) {
  const open = ledgerAlerts(dir, server);
  if (!open.length) return [];
  const acked = readJson(ackFile(dir), []);
  const keys = readJson(keyFile(dir), {});
  for (const a of open) {
    acked.push(a.id);
    if (a.kind === "key_changed" && a.got?.public_key_pem) keys[a.server] = { kid: a.got.kid, public_key_pem: a.got.public_key_pem, pinned_at: new Date().toISOString(), after_ack: a.id };
    else if (a.got?.hash && a.got?.seq != null) storeVerified(dir, a.server, a.got, "rebased-after-ack", { ack: a.id });
  }
  writeFileSync(ackFile(dir), JSON.stringify(acked));
  writeFileSync(keyFile(dir), JSON.stringify(keys, null, 1));
  return open;
}
/** One line per open alert, for the banner. */
export const alertLine = (a) => a.kind === "key_changed"
  ? "LEDGER SIGNING KEY CHANGED on " + a.server + ": pinned " + (a.stored?.kid || "?") + ", now " + (a.got?.kid || "?") + ". Heads are no longer checked against the key you first saw."
  : "LEDGER FORK on " + a.server + ": " + a.detail + " (stored seq " + (a.stored?.seq ?? "?") + ", server now shows seq " + (a.got?.seq ?? "?") + ")";

// ---------------- the check ----------------
async function getJson(fetchImpl, url, headers, timeoutMs) {
  const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) { const e = new Error("HTTP " + r.status + " from " + url); e.status = r.status; throw e; }
  return r.json();
}

async function signingKey({ dir, server, kid, fetchImpl, timeoutMs }) {
  const keys = readJson(keyFile(dir), {});
  const pinned = keys[server];
  if (pinned && (!kid || pinned.kid === kid)) return { pem: pinned.public_key_pem, kid: pinned.kid };
  const pub = await getJson(fetchImpl, server + "/.well-known/agentchan-signing-key.json", {}, timeoutMs);
  if (!pub.public_key_pem) return { pem: null };
  if (!pinned) {
    keys[server] = { kid: pub.kid, public_key_pem: pub.public_key_pem, pinned_at: new Date().toISOString() };
    mkdirSync(dir, { recursive: true });
    writeFileSync(keyFile(dir), JSON.stringify(keys, null, 1));
    return { pem: pub.public_key_pem, kid: pub.kid, first: true };
  }
  return { changed: true, pinned, now: { kid: pub.kid, public_key_pem: pub.public_key_pem } };
}

/**
 * checkLedger({ server, headers, dir, fetchImpl, maxPages, timeoutMs }) -> { status, head?, alert?, verified_through? }
 * status: first | same | extended | partial | fork | key_changed | bad_signature | unavailable | unsupported | empty
 * Never throws for network trouble (unavailable); throws only for a programming error.
 */
export async function checkLedger({ server, headers = {}, dir = HOME_STORE, fetchImpl = fetch, maxPages = 1, timeoutMs = 4000 } = {}) {
  server = String(server).replace(/\/mcp$/, "").replace(/\/$/, "");
  let got;
  try { got = await getJson(fetchImpl, server + "/ledger/head", headers, timeoutMs); }
  // 404: a server from before signed heads. Nothing to check and nothing wrong, so not "unavailable" (which is logged).
  catch (e) { return e.status === 404 ? { status: "unsupported" } : { status: "unavailable", why: e.message }; }
  const head = got?.head;
  if (!head?.hash) return { status: "empty" };
  // 1. signature
  const signed = got.signed;
  let signedOk = false;
  if (signed?.signature) {
    let k;
    try { k = await signingKey({ dir, server, kid: signed.signature.kid, fetchImpl, timeoutMs }); }
    catch (e) { return { status: "unavailable", why: "signing key: " + e.message }; }
    if (k.changed) {
      const a = { kind: "key_changed", detail: "the server signs heads with a different key than the one pinned on first use", stored: { kid: k.pinned.kid }, got: { kid: k.now.kid, public_key_pem: k.now.public_key_pem }, evidence: { head: got } };
      const r = recordAlert(dir, server, a);
      return { status: "key_changed", alert: { ...a, id: r.id } };
    }
    const v = k.pem ? verifySignedWrapper(signed, k.pem) : { ok: false, why: "no public key" };
    const b = signed.body || {};
    if (!v.ok || Number(b.seq) !== Number(head.seq) || b.hash !== head.hash) {
      const a = { kind: "bad_signature", detail: "the head's signature does not verify (" + (v.why || "signed body differs from the head") + ")", stored: null, got: { seq: head.seq, hash: head.hash }, evidence: { head: got } };
      const r = recordAlert(dir, server, a);
      return { status: "bad_signature", alert: { ...a, id: r.id } };
    }
    signedOk = true;
  }
  // 2. against the last verified head
  const last = lastVerifiedHead(dir, server);
  if (!last) { storeVerified(dir, server, head, "first", { signed: signedOk }); return { status: "first", head }; }
  const fork = (detail, extra = {}) => {
    const a = { kind: "fork", detail, stored: { seq: Number(last.seq), hash: last.hash }, got: { seq: Number(head.seq), hash: head.hash, prev_hash: head.prev_hash ?? null, at: head.at ?? null }, evidence: { head: got, ...extra } };
    const r = recordAlert(dir, server, a);
    return { status: "fork", alert: { ...a, id: r.id } };
  };
  if (Number(head.seq) === Number(last.seq)) return head.hash === last.hash ? { status: "same", head } : fork("the server now shows a different hash for the head seq this machine stored");
  if (Number(head.seq) < Number(last.seq)) return fork("the ledger went backwards: the server's head is older than one this machine already verified");
  // 3. walk the consistency view from the stored head to the new one
  let from = Number(last.seq), prev = null, pages = 0;
  while (pages++ < maxPages) {
    let page;
    try { page = await getJson(fetchImpl, server + "/ledger/consistency?from=" + from + "&to=" + Number(head.seq), headers, timeoutMs); }
    catch (e) { return { status: "unavailable", why: "consistency: " + e.message }; }
    const body = page?.body;
    if (!body || !Array.isArray(body.rows)) return { status: "unavailable", why: "consistency: unexpected response" };
    if (page.signature) {
      const k = await signingKey({ dir, server, kid: page.signature.kid, fetchImpl, timeoutMs }).catch(() => ({}));
      const v = k.pem ? verifySignedWrapper(page, k.pem) : { ok: false, why: "no pinned key for this kid" };
      if (!v.ok) return fork("the consistency proof's signature does not verify (" + v.why + ")", { consistency: page });
    }
    const rows = body.rows;
    if (!rows.length) return fork("the stored head's row is gone from the ledger", { consistency: page });
    for (const r of rows) {
      if (prev === null) {
        if (Number(r.seq) !== Number(last.seq) || r.hash !== last.hash) return fork("the row this machine stored as head (seq " + last.seq + ") is no longer in the chain with the same hash", { consistency: page });
      } else if (Number(r.seq) !== Number(prev.seq)) { // a page repeats its first row: the previous page's last
        if (Number(r.seq) < Number(prev.seq)) return fork("the consistency rows are out of order", { consistency: page });
        if (r.prev_hash !== prev.hash) return fork("the chain breaks between seq " + prev.seq + " and seq " + r.seq, { consistency: page });
      } else if (r.hash !== prev.hash) return fork("two pages disagree about seq " + r.seq, { consistency: page });
      if (r.canonical !== undefined) {
        if (sha256(r.canonical) !== r.hash || !String(r.canonical).startsWith((r.prev_hash ?? "") + "|" + r.seq + "|")) return fork("row seq " + r.seq + " (one of yours) does not hash to its stored hash", { consistency: page });
      }
      prev = r;
    }
    if (body.complete) {
      if (Number(prev.seq) !== Number(head.seq) || prev.hash !== head.hash) return fork("the chain from the stored head does not end at the signed head", { consistency: page });
      storeVerified(dir, server, head, "consistency", { signed: signedOk, from_seq: Number(last.seq) });
      return { status: "extended", head, verified_through: Number(head.seq) };
    }
    from = Number(prev.seq);
  }
  // Out of pages for this run: keep the progress. The furthest verified row becomes the witness; the next run resumes.
  if (prev && Number(prev.seq) > Number(last.seq)) storeVerified(dir, server, { seq: prev.seq, hash: prev.hash, prev_hash: prev.prev_hash }, "partial", { from_seq: Number(last.seq) });
  return { status: "partial", head, verified_through: prev ? Number(prev.seq) : Number(last.seq) };
}

/** checkLedger at most every everyMs per server (the hook runs on every prompt). Returns the result or null if throttled. */
export async function maybeCheckLedger(opts = {}, everyMs = 10 * 60_000) {
  const dir = opts.dir || HOME_STORE;
  const server = String(opts.server).replace(/\/mcp$/, "").replace(/\/$/, "");
  const stamps = readJson(stampFile(dir), {});
  if (stamps[server] && Date.now() - stamps[server] < everyMs) return null;
  stamps[server] = Date.now();
  try { mkdirSync(dir, { recursive: true }); writeFileSync(stampFile(dir), JSON.stringify(stamps)); } catch {}
  return checkLedger({ ...opts, server, dir });
}
