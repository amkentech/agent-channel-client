// Why this exists: the hook swallowed every failure by design. Its header said "Silent on any failure" and it
// meant it - 21 bare `catch {}` blocks. The silence is load-bearing and must stay: a hook that throws breaks the
// human's prompt, and a stale notice beats a broken session. But swallowing an error and recording NOTHING is a
// different decision, and it is the one that let three silent-failure bugs ship inside a week (2026-08-27): a
// sibling runtime's peek.json read as our own and the banner never fired; items stamped "shown" that were never
// displayed; a parked ack id pruned as if the row were resolved. In every case the code did exactly what it was
// told and told no one. Codex found the third only by paying ~12-14k tokens and noticing.
//
// So: record, never raise. One JSON line per swallowed failure, in a per-runtime file next to the peek cache,
// size-capped so it cannot grow without bound, and readable by `doctor`. This is local diagnostic state - it
// never goes to the server, never blocks, and every function here is itself failure-proof.

import { appendFileSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 64 * 1024;   // ~400 records; a hook that fails more than that has a standing problem, not an incident
const KEEP_ON_ROLL = 100;

export const diagFile = (root, runtime) => join(root, "diag-" + runtime + ".jsonl");

/** Record one swallowed failure. Never throws, never blocks, never rethrows: a diagnostic that can break the
 *  hook is worse than the silence it replaces. `step` is a stable dotted label so counts can be aggregated. */
export function diag(root, runtime, step, err) {
  try {
    const f = diagFile(root, runtime);
    try {
      if (statSync(f).size > MAX_BYTES) {
        const keep = readFileSync(f, "utf8").split("\n").filter(Boolean).slice(-KEEP_ON_ROLL);
        writeFileSync(f, keep.join("\n") + "\n");
      }
    } catch {}
    const msg = String((err && (err.message || err.code)) || err || "").slice(0, 300);
    appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), step, err: msg }) + "\n");
  } catch {}
}

/** What doctor reads. Newest last (append order), malformed lines dropped rather than fatal - a corrupted
 *  diagnostic file must not become the thing that breaks the tool built to inspect it. */
export function readDiag(root, runtime, limit = 20) {
  try {
    const lines = readFileSync(diagFile(root, runtime), "utf8").split("\n").filter(Boolean);
    const out = [];
    for (const l of lines.slice(-limit)) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } catch { return []; }
}

/** Group recent records by step, so doctor can say "peek.fetch failed 6 times" instead of printing six lines.
 *  Returns newest-first by last occurrence, because the thing that just broke is the thing you are looking for. */
export function summarizeDiag(records) {
  const by = new Map();
  for (const r of records) {
    const k = r.step || "unknown";
    const cur = by.get(k) || { step: k, count: 0, last_at: null, last_err: null };
    cur.count += 1; cur.last_at = r.at || cur.last_at; cur.last_err = r.err || cur.last_err;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => String(b.last_at || "").localeCompare(String(a.last_at || "")));
}
