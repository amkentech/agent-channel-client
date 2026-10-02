// Session isolation (SPRINT-multiclient item 8, revised 2026-09-27: claims are per THREAD).
//
// Delivery is per RUNTIME, not per conversation: every Claude Code session on a machine is the same `claude-code`
// agent and the hooks live in user-level settings, so before this every session rendered every banner, and
// handoffs landed in unrelated conversations. Johnathan works one chat per person or item, so the unit of routing
// is the THREAD: a contract / team / queue item id when an item carries one, else the counterparty handle, with the
// person's own cross-runtime handoffs as the thread "self".
//
//     <store>/<handle>/claims.<runtime>.json
//         { home:    { session_id, cwd, claimed_at, last_active_at } | null,
//           threads: { "<key>": { session_id, cwd, claimed_at, last_active_at } } }
//     <store>/<handle>/sessions.<runtime>/<session_id>.json     per-session display state, written only by that
//                                                              session's own hooks: { muted, last_count, btw }
//
// Routing: a claimed, non-stale thread goes to its session; everything else goes to home. home is taken
// automatically when absent or idle 30+ minutes. A thread claim idle 30+ minutes falls back to home. A host that
// sends no session_id gets the old behaviour: role "legacy", nothing read or written.
//
// Everything that decides is pure (threadOf*, routeFor, decide, parseChannelCommand, threadFromToolInput,
// countLine). The file helpers are synchronous, never throw, and write atomically (tmp + rename) because several
// sessions' hooks share the claims file.
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const STALE_MS = 30 * 60 * 1000;
const TOUCH_MS = 60 * 1000;                 // last_active_at refreshed at most once a minute (btw runs per tool call)
const SESSION_FILE_TTL_MS = 14 * 24 * 3600 * 1000;

/** Hook argv runtime ('claude', 'codex') and server slug ('claude-code') fold to one key, as owner files do. */
export const rtKey = (s) => String(s || "").toLowerCase().replace(/-code$/, "");

export const claimsPath = (root, handle, runtime) => join(root, handle, "claims." + rtKey(runtime) + ".json");
const safeSid = (sid) => String(sid).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
export const sessionPath = (root, handle, runtime, sid) => join(root, handle, "sessions." + rtKey(runtime), safeSid(sid) + ".json");

// ---------------- thread keys (pure) ----------------
const HANDLE_RE = /@([a-z0-9][a-z0-9_-]{2,31})/i;
const normHandle = (h) => "@" + String(h).replace(/^@/, "").toLowerCase();

/** Normalise a key typed by a human or found in a tool input. */
export function normKey(raw, myHandle) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^(self|me)$/i.test(s)) return "self";
  // a handle is 3-32 chars; contract / item ids are UUIDs (36), so the length alone keeps them apart
  if (/^@?[a-z0-9][a-z0-9_-]{2,31}$/i.test(s)) {
    const h = normHandle(s);
    return myHandle && h === normHandle(myHandle) ? "self" : h;
  }
  if (/^team:/i.test(s)) return s.toLowerCase();
  if (/@/.test(s) && /\./.test(s)) return s.toLowerCase();   // an email (draft_contract with a non-member)
  return s.toLowerCase();                                    // contract / item / team id
}

const idKey = (o) => {
  if (!o) return null;
  const id = o.contract_id || o.item_id || o.queue_item_id;
  if (id) return String(id);
  const team = o.team_id || (typeof o.team === "string" ? o.team : null);
  return team ? "team:" + team : null;
};

/** Thread of a /peek item or a listener event. */
export function threadOfItem(i, myHandle) {
  const id = idKey(i);
  if (id) return String(id).toLowerCase();
  if (i?.type === "handoff") return "self";
  if (!i?.from) return "home";
  return normKey(i.from, myHandle) || "home";
}

/** Thread of a /peek summary line (no structure, so the handle is read out of the text). */
export function threadOfLine(s, myHandle) {
  const t = String(s || "");
  if (/^handoff\b/i.test(t)) return "self";
  const m = t.match(HANDLE_RE);
  return m ? normKey(m[0], myHandle) : "home";
}

/** Which thread an agent-channel MCP tool call targets, from its tool_input; null when it names none. */
export function threadFromToolInput(input, myHandle) {
  if (!input || typeof input !== "object") return null;
  const id = idKey(input);
  if (id) return String(id).toLowerCase();
  if (input.to_runtime) return "self";
  for (const f of ["to", "handle", "with", "person"]) {
    if (typeof input[f] === "string" && input[f].trim()) return normKey(input[f], myHandle);
  }
  return null;
}

/** PostToolUse tool names that mean "this session is using the channel". */
export const isChannelTool = (name) => /^mcp__agent[-_]channel__/i.test(String(name || ""));

/**
 * `@channel <cmd>` as the first line of a prompt -> { cmd, key } | null.
 * cmd: here | off | take | drop | status. take/drop need a key (@alice, self, or an id).
 */
export function parseChannelCommand(prompt, myHandle) {
  const m = String(prompt || "").match(/^\s*@channel(?:[ \t]+(here|off|take|drop|status)(?:[ \t]+(\S+))?)?[ \t]*(?:\r?\n|$)/i);
  if (!m) return null;
  const cmd = (m[1] || "status").toLowerCase();
  const key = m[2] ? normKey(m[2], myHandle) : null;
  if ((cmd === "take" || cmd === "drop") && !key) return { cmd: "status", key: null };
  return { cmd, key };
}

// ---------------- routing (pure) ----------------
const lastMs = (c) => Date.parse(c?.last_active_at || c?.claimed_at || "") || 0;
export const live = (c, now = Date.now(), staleMs = STALE_MS) => !!c && !!c.session_id && now - lastMs(c) < staleMs;

/** The session id a thread routes to under `claims` (after home has been resolved), or null. */
export function routeFor(claims, key, now = Date.now()) {
  const t = claims?.threads?.[key];
  if (live(t, now)) return t.session_id;
  return live(claims?.home, now) ? claims.home.session_id : null;
}

/**
 * decide({ claims, sessionId, cwd, now, muted, autoHome, takeThread }) -> { claims, changed }
 * Applies the automatic rules for one hook run of session `sessionId`: refresh last_active_at on everything it
 * holds (throttled), drop its stale entries, take home when vacant (autoHome), claim `takeThread` (a tool call).
 * A muted session never takes anything.
 */
export function decide({ claims, sessionId, cwd, now = Date.now(), muted = false, autoHome = true, takeThread = null }) {
  const c = { home: claims?.home || null, threads: { ...(claims?.threads || {}) } };
  let changed = false;
  const iso = new Date(now).toISOString();
  const fresh = () => ({ session_id: sessionId, cwd: cwd || null, claimed_at: iso, last_active_at: iso });
  const touch = (e) => (now - lastMs(e) >= TOUCH_MS ? (changed = true, { ...e, last_active_at: iso }) : e);
  if (c.home && c.home.session_id === sessionId) c.home = touch(c.home);
  for (const [k, t] of Object.entries(c.threads)) {
    if (t?.session_id === sessionId) c.threads[k] = touch(t);
    else if (!live(t, now)) { delete c.threads[k]; changed = true; }   // stale: the thread falls back to home
  }
  if (!muted) {
    if (autoHome && !live(c.home, now)) { c.home = fresh(); changed = true; }
    if (takeThread && c.threads[takeThread]?.session_id !== sessionId) { c.threads[takeThread] = fresh(); changed = true; }
  }
  return { claims: c, changed };
}

/** Apply a typed `@channel` command. Returns { claims, session, receipt }. */
export function applyCommand({ claims, session, sessionId, cwd, cmd, key, now = Date.now() }) {
  const c = { home: claims?.home || null, threads: { ...(claims?.threads || {}) } };
  const s = { ...(session || {}) };
  const iso = new Date(now).toISOString();
  const fresh = () => ({ session_id: sessionId, cwd: cwd || null, claimed_at: iso, last_active_at: iso });
  let receipt;
  if (cmd === "here") { c.home = fresh(); s.muted = false; receipt = "this session is now your channel session: unclaimed items land here"; }
  else if (cmd === "off") {
    s.muted = true;
    if (c.home?.session_id === sessionId) c.home = null;
    for (const [k, t] of Object.entries(c.threads)) if (t?.session_id === sessionId) delete c.threads[k];
    receipt = "muted in this session: no channel output here for the rest of it";
  } else if (cmd === "take") { c.threads[key] = fresh(); s.muted = false; receipt = key + " now lands in this session"; }
  else if (cmd === "drop") { delete c.threads[key]; receipt = key + " released; it goes to your channel session again"; }
  else {
    const mine = Object.entries(c.threads).filter(([, t]) => t?.session_id === sessionId && live(t, now)).map(([k]) => k);
    const home = live(c.home, now) && c.home.session_id === sessionId;
    receipt = (s.muted ? "muted here. " : "") + (home ? "this is your channel session" : "this is not your channel session") + (mine.length ? "; threads here: " + mine.join(", ") : "") + ". Commands: @channel here | take @x | drop @x | off";
  }
  return { claims: c, session: s, receipt: "[Agent Channel] " + receipt };
}

/** The only line a session that is not the destination ever sees. */
export const countLine = (n) =>
  "Agent Channel: " + n + " item" + (n === 1 ? "" : "s") + " waiting in your channel session. Type `@channel here` to take them here.";

/** Show the count line only when it changed since this session last saw it, and never a zero it has not shown. */
export const shouldShowCount = (lastShown, n) => n > 0 && n !== lastShown;

// ---------------- files (never throw) ----------------
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
function writeAtomic(p, v) {
  try {
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = p + "." + process.pid + "." + Math.random().toString(36).slice(2) + ".tmp";
    writeFileSync(tmp, JSON.stringify(v));
    renameSync(tmp, p);
    return true;
  } catch { try { writeFileSync(p, JSON.stringify(v)); return true; } catch { return false; } }
}

export function readClaims(root, handle, runtime) {
  const c = readJson(claimsPath(root, handle, runtime));
  if (!c || typeof c !== "object") return { home: null, threads: {} };
  return { home: c.home && typeof c.home === "object" ? c.home : null, threads: c.threads && typeof c.threads === "object" ? c.threads : {} };
}
export const writeClaims = (root, handle, runtime, claims) => writeAtomic(claimsPath(root, handle, runtime), claims);

export function readSession(root, handle, runtime, sid) {
  const s = readJson(sessionPath(root, handle, runtime, sid));
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}
export const writeSession = (root, handle, runtime, sid, s) => writeAtomic(sessionPath(root, handle, runtime, sid), { ...s, seen_at: Date.now() });

/** Session files are one per conversation ever; drop the ones untouched for two weeks. Called on SessionStart. */
export function pruneSessions(root, handle, runtime, now = Date.now()) {
  const dir = join(root, handle, "sessions." + rtKey(runtime));
  try {
    for (const f of readdirSync(dir)) {
      if (!/\.json$/.test(f)) continue;
      try { if (now - statSync(join(dir, f)).mtimeMs > SESSION_FILE_TTL_MS) unlinkSync(join(dir, f)); } catch {}
    }
  } catch {}
}

/**
 * resolve(root, handle, runtime, { sessionId, cwd, autoHome, takeThread, now }) -> { legacy, claims, session, muted }
 * One call per hook run: reads the claims and this session's state, applies the automatic rules, writes back
 * only when something changed. No session id -> { legacy: true } and nothing is touched.
 */
export function resolve(root, handle, runtime, { sessionId, cwd, autoHome = true, takeThread = null, now = Date.now() } = {}) {
  if (!sessionId || !handle) return { legacy: true, claims: null, session: {}, muted: false };
  const session = readSession(root, handle, runtime, sessionId);
  const r = decide({ claims: readClaims(root, handle, runtime), sessionId, cwd, now, muted: !!session.muted, autoHome, takeThread });
  if (r.changed) writeClaims(root, handle, runtime, r.claims);
  return { legacy: false, claims: r.claims, session, muted: !!session.muted };
}

// ---------------- peek routing (pure) ----------------
/**
 * routePeek(peek, isMine, myHandle) -> { mine, elsewhere }
 * Splits a /peek body into the part this session renders and a count of what routes to other sessions.
 * /peek lists message lines first, one per item and in item order, then proposal lines, then file lines; message
 * lines are routed with their item so the two cannot disagree. Stale sibling-runtime handoffs are the "self"
 * thread. `mine` keeps the /peek shape, so the hook's rendering path is unchanged.
 */
export function routePeek(peek, isMine, myHandle) {
  if (!peek) return { mine: peek, elsewhere: 0 };
  const items = peek.items || [];
  const summary = peek.summary || [];
  const nMsg = Math.min(items.length, summary.length);
  const itemsMine = [], msgLines = [];
  let elsewhere = 0;
  items.forEach((it, i) => {
    if (isMine(threadOfItem(it, myHandle))) { itemsMine.push(it); if (i < nMsg) msgLines.push(summary[i]); }
    else elsewhere++;
  });
  const extra = summary.slice(nMsg);
  const extraCap = (peek.proposals_awaiting_you || 0) + (peek.artifacts_waiting || 0);
  const extraMine = extra.filter((s) => isMine(threadOfLine(s, myHandle)));
  const extraCounted = Math.min(extraCap, extra.length);
  const extraMineCounted = Math.min(extraMine.length, extraCounted);
  elsewhere += extraCounted - extraMineCounted;
  const selfMine = isMine("self");
  return {
    mine: {
      ...peek,
      items: itemsMine,
      unread_messages: itemsMine.length,
      proposals_awaiting_you: extraMineCounted,
      artifacts_waiting: 0,
      summary: [...msgLines, ...extraMine],
      handoffs_for_other_runtimes: selfMine ? (peek.handoffs_for_other_runtimes || []) : [],
      handoffs_you_sent: selfMine ? (peek.handoffs_you_sent || []) : [],
      sent: isMine("home") ? peek.sent : [],
    },
    elsewhere,
  };
}

/** peek minus the given message ids and their summary lines, keeping /peek's line alignment intact. */
export function removeFromPeek(peek, ids) {
  if (!peek) return peek;
  const drop = new Set(ids);
  const items = peek.items || [];
  const summary = peek.summary || [];
  const nMsg = Math.min(items.length, summary.length);
  const keptItems = [], keptLines = [];
  items.forEach((it, i) => { if (!drop.has(it.id)) { keptItems.push(it); if (i < nMsg) keptLines.push(summary[i]); } });
  const removed = items.length - keptItems.length;
  return { ...peek, items: keptItems, unread_messages: Math.max(0, (peek.unread_messages || 0) - removed), summary: [...keptLines, ...summary.slice(nMsg)] };
}

// ---------------- mid-turn cursor (shared by btw.mjs and inbox.mjs) ----------------
/** Dedupe key for one listener event. An event carrying a server id is keyed by type + id alone: both listeners
 *  (claude and codex) append the same push, and anything that differs between their copies must not split one
 *  event into two notices. Id-less events keep the composite key. */
export const eventKey = (e) => {
  const id = e.message_id || e.artifact_id || e.connection_id || e.contract_id || e.item_id;
  return id ? (e.type || "") + "|" + id : [e.type || "", e.from || "", e.summary || "", e.at || ""].join("|");
};
export const BTW_SEEN_MAX = 50;

/** A btw cursor positioned at the end of events.jsonl now, remembering the tail's keys. inbox.mjs seeds one for a
 *  session at its first prompt: the banner has covered everything up to here, and a mid-turn arrival after it
 *  must not be swallowed by btw's silent first-run adoption. */
export function cursorAtEnd(eventsFile) {
  try {
    const lines = readFileSync(eventsFile, "utf8").split("\n").filter((l) => l.trim());
    const seen = [];
    for (const l of lines.slice(-BTW_SEEN_MAX)) { try { seen.push(eventKey(JSON.parse(l))); } catch {} }
    return { count: lines.length, mtime: statSync(eventsFile).mtimeMs, seen };
  } catch { return { count: 0, mtime: 0, seen: [] }; }
}
