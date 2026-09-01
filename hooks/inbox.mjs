#!/usr/bin/env node
// Runtime-agnostic hook for SessionStart + UserPromptSubmit (Claude Code and Codex share the schema).
//
//   node hooks/inbox.mjs claude UserPromptSubmit     token from AGENTCHAN_TOKEN       (fallback .tok.claude.json)
//   node hooks/inbox.mjs codex  SessionStart         token from AGENTCHAN_CODEX_TOKEN (fallback .tok.codex.json)
//
// Two jobs:
//  1. FAST PATH (UserPromptSubmit only). If the prompt's first line starts with "@handle", it is a message
//     from the human to that person. It is sent over the wire right here; no model is involved.
//     Communication is transport, not inference. Forms:
//        @sam are you still blocked on auth?          -> human message
//        @sam send ./export.txt [note...]             -> end-to-end encrypted file (scripts/artifact.mjs)
//     The prompt is then blocked (Claude Code) so the model never spends a turn on it; the human sees a one-line receipt.
//  2. WAITING REPORT. If anything is waiting for this person, print a block: human messages in full (then acked),
//     proposals, human-only items, files received by the listener. Output is JSON: systemMessage (human sees it)
//     + hookSpecificOutput.additionalContext (agent sees it). Silent when nothing is waiting.
//
// Data path: the resident listener (scripts/listen.mjs) keeps ~/.agentchan/<handle>/peek.json fresh; this reads that
// with no network call. Slow path: /peek directly, throttled to one call per 20s. Silent on any failure.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tokenFor, tokenEnvFor, fileTokenFor } from "../lib/paths.mjs";
import { splitSurfaced } from "../lib/surfaced.mjs";
import { trustedPeek } from "../lib/peek-cache.mjs";
import { diag } from "../lib/diag.mjs";
import { buildBanner } from "../lib/banner.mjs";

const runtime = (process.argv[2] || "claude").toLowerCase();
let eventName = process.argv[3] || "";
const url = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let token = tokenFor(runtime);
if (!token) process.exit(0);
const H = { authorization: "Bearer " + token, "content-type": "application/json" };

// ---- stdin (hook payload), bounded so a hook can never hang ----
let input = {};
try {
  const raw = await new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    const chunks = []; let done = false;
    const finish = () => { if (!done) { done = true; res(Buffer.concat(chunks).toString("utf8")); } };
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, 500).unref();
  });
  if (raw) input = JSON.parse(raw);
} catch {}
if (!eventName) eventName = input.hook_event_name || "UserPromptSubmit";

const root = join(homedir(), ".agentchan");
try { mkdirSync(root, { recursive: true }); } catch {}
const out = (obj) => { process.stdout.write(JSON.stringify(obj)); process.exit(0); };

// ---- who am I locally (from the listener's marker) ----
let myHandle = null;
try {
  for (const h of readdirSync(root)) {
    try { if (readFileSync(join(root, h, "owner." + runtime), "utf8") === "1") myHandle = h; } catch {}
  }
} catch (e) { diag(root, runtime, "identity.scan", e); }

// ================= 1. FAST PATH =================
const prompt = typeof input.prompt === "string" ? input.prompt : "";
if (eventName === "UserPromptSubmit" && prompt) {
  // a handle is followed by whitespace, light punctuation, or end of line; "@src/auth/login.ts why" and "@README.md ..." are file
  // mentions, not people, so a following / . \ or anything else leaves the prompt alone
  const m = prompt.match(/^\s*@([a-z0-9][a-z0-9_-]{2,31})(?=$|[ \t\r\n,:;!?])[ \t,:;]*([\s\S]*)$/i);
  if (m) {
    const to = m[1].toLowerCase();
    const rest = m[2].trim();
    if (to !== myHandle && rest) {
      let receipt, ok = false, agentNote;
      // "@sam send-conversation [--last N] [--since "auth bug"] [note]"
      const convo = rest.match(/^(?:send-conversation|send-chat|send-convo|send-transcript)\b\s*((?:--(?:last\s+\d+|since\s+(?:"[^"]*"|'[^']*'|\S+))\s*)*)([\s\S]*)$/i);
      const convoLast = convo ? convo[1].match(/--last\s+(\d+)/i)?.[1] : null;
      const convoSince = convo ? (convo[1].match(/--since\s+"([^"]*)"/i) || convo[1].match(/--since\s+'([^']*)'/i) || convo[1].match(/--since\s+(\S+)/i))?.[1] : null;
      const fileCmd = convo ? null : rest.match(/^(?:send|file)\s+("[^"]+"|'[^']+'|\S+)\s*([\s\S]*)$/i);
      if (convo) {
        // "send me the conversation": export this session's transcript (redacted), then send it E2E encrypted
        const note = convo[2].trim();
        try {
          const args = [join(REPO, "scripts", "export-conversation.mjs"), "--runtime", runtime, "--cwd", input.cwd || process.cwd(), "--send", "@" + to];
          if (convoLast) args.push("--last", convoLast);
          if (convoSince) args.push("--since", convoSince);
          if (note) args.push("--note", note);
          if (input.session_id) args.push("--session", String(input.session_id));
          const r = execFileSync(process.execPath, args, { env: { ...process.env, AGENTCHAN_TOKEN: token, AGENTCHAN_RUNTIME: runtime }, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"] });
          receipt = "[Agent Channel] conversation " + r.trim().split("\n").join(" | "); ok = true;
        } catch (e) {
          receipt = "[Agent Channel] conversation NOT sent to @" + to + ": " + ((e.stderr || e.stdout || e.message || "").toString().trim().split("\n").pop() || "unknown error");
        }
      } else if (fileCmd) {
        const path = fileCmd[1].replace(/^["']|["']$/g, "");
        const note = fileCmd[2].trim();
        try {
          const args = [join(REPO, "scripts", "artifact.mjs"), "send", "@" + to, resolve(path)];
          if (note) args.push("--note", note);
          const r = execFileSync(process.execPath, args, { env: { ...process.env, AGENTCHAN_TOKEN: token, AGENTCHAN_RUNTIME: runtime }, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
          receipt = "[Agent Channel] " + r.trim(); ok = true;
        } catch (e) {
          receipt = "[Agent Channel] file NOT sent to @" + to + ": " + ((e.stderr || e.stdout || e.message || "").toString().trim().split("\n").pop() || "unknown error");
        }
      } else {
        try {
          const r = await fetch(url + "/say", { method: "POST", headers: H, body: JSON.stringify({ to: "@" + to, text: rest }), signal: AbortSignal.timeout(8000) });
          const j = await r.json().catch(() => ({}));
          if (r.ok) { receipt = "[Agent Channel] sent to @" + to + ": " + (rest.length > 140 ? rest.slice(0, 140) + "..." : rest); ok = true; }
          else receipt = "[Agent Channel] NOT delivered to @" + to + ": " + (j.error || r.status);
        } catch (e) { receipt = "[Agent Channel] NOT delivered to @" + to + ": " + e.message; }
      }
      agentNote = ok
        ? "The user's prompt was a direct message to @" + to + ". The Agent Channel hook already delivered it with no model involvement. Do NOT send it again with any tool. If you must respond at all, one line acknowledging it was sent is enough."
        : "The user's prompt was a direct message to @" + to + " but the Agent Channel hook could not deliver it: " + receipt + ". Tell the user, and if the reason is a missing connection offer to run the connect tool.";
      // Claude Code renders the block reason as a receipt, so blocking is right there: no model turn.
      // Codex prints a bare "operation blocked by hook" and hides the reason, which reads as an error.
      // For Codex, let the prompt through with the receipt as context; the model just confirms in one line.
      if (runtime === "claude") {
        out({ decision: "block", reason: receipt, systemMessage: receipt,
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: agentNote } });
      }
      // Codex shows only what the model prints: hand it a tidy one-liner to echo.
      const codexReceipt = (ok ? "✓ " : "✗ ") + receipt.replace(/^\[Agent Channel\]\s*/, "Agent Channel · ");
      out({ systemMessage: receipt,
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: agentNote + " Reply with exactly this line and nothing else: " + codexReceipt } });
    }
  }
}

// ================= 2. WAITING REPORT =================
// A peek can come from three places, in descending order of trust: fetched live this run, the listener's
// peek.json, or the runtime's short-lived cache. Only the first is server truth. Items are marked read by
// things this hook never sees - my_inbox over MCP, another session, the human on their phone - and none of
// them touch the local files. So a peek read from disk means "something MIGHT be waiting", never "is".
let peek = null;
let verified = false;
let serverTruth = false; // a 200 /peek body was parsed THIS run. verified also goes true on a 401 (to stop re-fetching), but a denial proves nothing about which items are resolved, so pruning keys on it would be wrong.
let peekDenied = false; // 401/403: identity is dead. A stale unread cache then re-renders the same handoff on every prompt because ack also 401s and never clears the row.
const cacheFile = join(root, "peek-cache-" + runtime + ".json");
const emptyPeek = (handle) => ({ handle: handle || null, unread_messages: 0, sent: [], proposals_awaiting_you: 0, your_active_contracts: 0, artifacts_waiting: 0, summary: [], items: [] });
// env-first is tokenFor's policy, but the environment and the tok file drift: wire pinned the env var once,
// a later remint rewrote only the file, and this hook authenticated with the dead env token on every prompt
// for nine hours (2026-08-28, diag-claude.jsonl) -- 401 on /peek AND /ack, stale banner, nothing clearable.
// On the first 401, one probe with the file token; if the server takes it, the whole run switches to it.
// Both dead -> peekDenied semantics unchanged. Tried once per run, so a flapping server cannot loop this.
let healTried = false;
const healToken = async () => {
  if (healTried) return null;
  healTried = true;
  const envTok = process.env[tokenEnvFor(runtime)];
  const fileTok = fileTokenFor(runtime);
  if (!envTok || !fileTok || envTok === fileTok || token !== envTok) return null;
  try {
    const r = await fetch(url + "/peek", { headers: { ...H, authorization: "Bearer " + fileTok }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    token = fileTok; H.authorization = "Bearer " + fileTok;
    diag(root, runtime, "token.selfheal", "env token stale, using file token");
    return r;
  } catch (e) { diag(root, runtime, "token.selfheal", e); return null; }
};
const fetchPeek = async () => {
  try {
    let r = await fetch(url + "/peek", { headers: H, signal: AbortSignal.timeout(4000) });
    if (r.status === 401 || r.status === 403) {
      const healed = await healToken();
      if (healed) r = healed;
      else {
        diag(root, runtime, "peek.fetch.status", "HTTP " + r.status);
        peekDenied = true;
        return null;
      }
    }
    if (!r.ok) { diag(root, runtime, "peek.fetch.status", "HTTP " + r.status); return null; }
    const fresh = await r.json();
    // 2026-08-27: every peek.json write carries the writing runtime. /peek is runtime-scoped now, so the
    // file's content is one runtime's view; a sibling hook reading an unstamped fresh file computed n=0
    // and silently skipped a handoff meant for it. Readers distrust any stamp that is not their own.
    try { writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), runtime, peek: fresh })); } catch (e) { diag(root, runtime, "cache.write", e); }
    // keep the listener's copy in step, so a file it wrote before the read does not re-raise next prompt
    if (fresh?.handle) { try { writeFileSync(join(root, fresh.handle, "peek.json"), JSON.stringify({ at: Date.now(), runtime, peek: fresh })); } catch (e) { diag(root, runtime, "peekfile.write", e); } }
    return fresh;
  } catch (e) { diag(root, runtime, "peek.fetch", e); return null; }
};
if (myHandle) {
  try {
    const f = join(root, myHandle, "peek.json");
    // Trust the shared per-person file only when a matching runtime stamp says WE wrote it. A sibling
    // runtime's write omits our handoffs entirely (2026-08-27, /peek is runtime-scoped), so believing it
    // meant computing n=0 and silently skipping the banner for as long as the sibling kept the file fresh.
    // Mismatched or old unstamped format -> treated as absent; the per-runtime cache/fetch path below runs.
    if (Date.now() - statSync(f).mtimeMs < 120_000) peek = trustedPeek(JSON.parse(readFileSync(f, "utf8")), runtime);
  } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "peekfile.read", e); }
}
if (!peek) {
  let cache = {}; try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "cache.read", e); }
  peek = trustedPeek(cache, runtime);
  // fetch on the usual 20s throttle — or immediately when the cache was distrusted (old format), so a
  // stale-format file cannot buy a silent window
  if (!peek || !cache.at || Date.now() - cache.at > 20_000) {
    const fresh = await fetchPeek();
    if (fresh) { peek = fresh; verified = true; serverTruth = true; }
  }
}
// About to claim something is waiting, on the word of a file. Confirm with the server first. This costs one
// request and only on the rare prompt where there is anything to report; a false alarm costs the human's
// trust in every future notice, which is worth more. On failure keep the local peek: a stale notice beats
// silence when the network is down, and the report is only ever a pointer to my_inbox anyway.
// "Anything to report" is anything the banner WOULD render, not just the three numeric counters: a handoff
// rides in items[] and can sit there while all three counters read 0, and on 2026-08-28 exactly that shape
// let a stale listener file skip this confirm and re-render an already-superseded handoff for hours.
const renderable = (p) => !!p && (
  ((p.unread_messages || 0) + (p.proposals_awaiting_you || 0) + (p.artifacts_waiting || 0)) > 0
  || (p.items || []).length > 0
  || (p.summary || []).length > 0
  || (p.handoffs_for_other_runtimes || []).some((h) => h.status === "stale"));
if (!verified && renderable(peek)) {
  const fresh = await fetchPeek();
  if (fresh) { peek = fresh; verified = true; serverTruth = true; }
}
// 401/403 is not "network down, keep the stale notice". The token cannot read or ack, so the stale
// unread handoff re-renders in full on every prompt (seen-ids prune when a brief empty peek.json
// lands, then the cache looks like a first sighting). Drop local unread. Silence until doctor/wire
// replaces the token beats a banner the human already dismissed.
if (peekDenied) {
  peek = emptyPeek(myHandle || peek?.handle);
  verified = true;
  try { writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), runtime, peek })); } catch (e) { diag(root, runtime, "cache.write", e); }
  // The listener's shared per-person file can hold the same stale unread row, and the listener (its own
  // process, possibly its own token) may keep it fresh enough to pass the 120s trust window above -- so
  // clearing only the runtime cache leaves a second resurrection path. Stamp it empty with OUR runtime;
  // a healthy listener's next write simply replaces it.
  if (peek.handle) { try { writeFileSync(join(root, peek.handle, "peek.json"), JSON.stringify({ at: Date.now(), runtime, peek })); } catch (e) { diag(root, runtime, "peekfile.write", e); } }
}
if (peek?.handle && !myHandle) myHandle = peek.handle;

// files the listener has already fetched and inspected, not yet shown
const newFiles = [];
if (myHandle) {
  try {
    const seenF = join(root, myHandle, "artifacts.seen");
    const seen = new Set(existsSync(seenF) ? readFileSync(seenF, "utf8").split("\n").filter(Boolean) : []);
    const lines = readFileSync(join(root, myHandle, "artifacts.jsonl"), "utf8").split("\n").filter(Boolean);
    for (const l of lines) { try { const r = JSON.parse(l); if (!seen.has(r.id)) newFiles.push(r); } catch {} }
    if (newFiles.length) appendFileSync(seenF, newFiles.map((r) => r.id).join("\n") + "\n");
  } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "artifacts.read", e); }
}

// Claude Code: register the listener's notify file so FileChanged fires while idle (no model turn).
const watchPaths = (runtime === "claude" && eventName === "SessionStart" && myHandle) ? [join(root, myHandle, "agentchan_notify")] : null;
const finish = (obj) => { if (watchPaths) { obj = obj || {}; obj.hookSpecificOutput = { hookEventName: "SessionStart", ...(obj.hookSpecificOutput || {}), watchPaths }; } if (obj) out(obj); process.exit(0); };
if (!peek && !newFiles.length) finish(null);
// Delayed-ack ids parked by the PREVIOUS prompt (codex acks one prompt late: the model prints the banner
// during the turn AFTER the hook). 2026-08-27 round 3 (Codex CLI finding, ~12-14k tokens measured): this
// used to run after the banner was assembled, so a listener refresh from the still-unread server row
// between prompts re-rendered the full handoff body (~6 times for one handoff) before /ack ever fired.
// Load FIRST, exclude from everything built below, then post. The park file is cleared only on a
// successful POST, so a failed call loses no delivery - the ids stay excluded and the POST retries.
const pendingAckFile = myHandle ? join(root, myHandle, "pending-ack." + runtime + ".json") : null;
let parked = [];
if (pendingAckFile) { try { const prev = JSON.parse(readFileSync(pendingAckFile, "utf8")); if (Array.isArray(prev)) parked = prev.filter((x) => typeof x === "string"); } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "ack.parked.read", e); } }
let parkedRemaining = parked;
const parkedInPeek = (peek?.items || []).filter((i) => parked.includes(i.id)).length;
if (parked.length) {
  try {
    let r = await fetch(url + "/ack", { method: "POST", headers: H, body: JSON.stringify({ ids: parked }), signal: AbortSignal.timeout(4000) });
    // a parked ack can be the run's FIRST 401 (peek answered from a fresh local file, no fetch yet):
    // give the file token the same one chance here, or the park file retries a dead credential forever
    if ((r.status === 401 || r.status === 403) && (await healToken())) r = await fetch(url + "/ack", { method: "POST", headers: H, body: JSON.stringify({ ids: parked }), signal: AbortSignal.timeout(4000) });
    if (r.ok) { writeFileSync(pendingAckFile, "[]"); parkedRemaining = []; }
    else diag(root, runtime, "ack.post.status", "HTTP " + r.status);
  } catch (e) { diag(root, runtime, "ack.post", e); }
}
const items = (peek?.items || []).filter((i) => !parked.includes(i.id));
const humansAll = items.filter((i) => i.type === "human");
// handoffs addressed to THIS runtime: tasks the human handed over from another of their own CLIs. Shown in full and
// acked like human messages. 2026-08-27: handoffs for OTHER runtimes no longer arrive in summary/items at all —
// when they did, one addressed to codex re-fired this banner on every prompt in every other session, and those
// sessions could not clear it. The server now reports them only in peek.handoffs_for_other_runtimes (informational,
// not counted as unread), which this hook deliberately does not display.
const handsAll = items.filter((i) => i.type === "handoff" && i.for_this_runtime);
// Message-id seen markers: a human message or this-runtime handoff renders in FULL exactly once. Still
// unread on a later prompt (an ack POST failed, or a stale listener write landed after the ack)? Then a
// one-liner, never the full block again. renag Infinity: an id never becomes "fresh" twice - my_inbox has it.
const idsFile = join(root, "surfaced-ids-" + runtime + ".json");
let idMap = {}; try { idMap = JSON.parse(readFileSync(idsFile, "utf8")); } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "seen.ids.read", e); }
const ip = splitSurfaced(idMap, [...humansAll, ...handsAll].map((i) => i.id), Date.now(), Infinity);
// A parked id is hidden from `items` while its ack is in flight, so it is absent from the key list above and
// splitSurfaced's prune (live keys only) would drop its stamp - which is what "resolved" is supposed to mean.
// It is not resolved, only in flight: dropping the stamp made the very next stale listener write look like a
// first sighting and re-rendered the whole body (2026-08-27 round 3, the defect this test pins). Carry the
// existing stamps forward; ids the server has actually cleared leave `peek.items` and prune normally.
for (const id of parked) if (idMap[id] !== undefined) ip.next[id] = idMap[id];
// Prune only against SERVER truth. An unverified peek (stale file, network down) and the 401 empty-peek both
// present key lists that say nothing about what is resolved; pruning on them erased every stamp, so the next
// stale file made an already-shown handoff look like a first sighting and the full body re-rendered -- the
// 2026-08-28 loop. On anything but a parsed 200, carry every existing stamp forward.
if (!serverTruth) for (const [id, ts] of Object.entries(idMap)) if (ip.next[id] === undefined) ip.next[id] = ts;
try { writeFileSync(idsFile, JSON.stringify(ip.next)); } catch (e) { diag(root, runtime, "seen.ids.write", e); }
const firstTime = new Set(ip.fresh);
const humans = humansAll.filter((i) => firstTime.has(i.id));
const hands = handsAll.filter((i) => firstTime.has(i.id));
const repeats = [...humansAll, ...handsAll].filter((i) => !firstTime.has(i.id));
// Summary lines for humans and this-runtime handoffs are handled by the item paths above (full text,
// one-liner, or parked-hidden) - match ALL of them, not just the first-time set, or a repeat's summary
// line leaks back in through `others` and re-renders the body it was supposed to suppress.
// Handoffs addressed to a SIBLING runtime. These deliberately do not appear in summary/items - counting them
// is what re-fired this banner on every prompt in every other session. But a handoff the target runtime has
// been ONLINE since and still has not taken is a different thing: it is the only work-carrying primitive with
// no lifecycle, parked in a table that hard-deletes it after three days, so staying quiet means it vanishes.
// Only the stale ones surface, and they ride the same 6h seen-marker muting as every other summary line.
// The age is deliberately NOT in this text: the marker is keyed on the line, so a line that changes every
// prompt would never be recognised as already-shown and would re-nag forever - the exact bug this file exists
// to fix. The age and the expiry countdown are in my_inbox, which is where the line points.
const staleHandoffs = (peek?.handoffs_for_other_runtimes || [])
  .filter((h) => h.status === "stale")
  .map((h) => "handoff for " + (h.for_runtime || "another runtime") + " has not been taken up, though that runtime has been online since; my_inbox has it (and how long)");
const others = [...staleHandoffs, ...(peek?.summary || [])].filter((s) => !humansAll.some((h) => s.startsWith(h.from + ":") || s.startsWith(h.from + " (")) && !(s.startsWith("HANDOFF") && s.includes("(THIS session)")));
// Summary lines have no ack path (nothing sets read_at on a pending proposal), so before 2026-08-27 each one
// re-fired this banner verbatim on every prompt until resolved. Local seen-markers: full text the first time,
// a count line while recent, full again after 6h so nothing rots silently. Display state only - never the server's.
const surfacedFile = join(root, "surfaced-" + runtime + ".json");
let surfacedMap = {}; try { surfacedMap = JSON.parse(readFileSync(surfacedFile, "utf8")); } catch (e) { if (e?.code !== "ENOENT") diag(root, runtime, "seen.summary.read", e); }
// display and stamp the SAME set: stamping more than the display cut marked items "shown earlier" that
// never were (2026-08-27 round 3). Overflow stays unstamped and surfaces on the very next prompt.
const OTHERS_SHOWN = 6;
const sp = splitSurfaced(surfacedMap, others, Date.now(), 6 * 3600 * 1000, OTHERS_SHOWN);
// same rule as the message-id stamps above: only a parsed 200 may prune
if (!serverTruth) for (const [k, ts] of Object.entries(surfacedMap)) if (sp.next[k] === undefined) sp.next[k] = ts;
try { writeFileSync(surfacedFile, JSON.stringify(sp.next)); } catch (e) { diag(root, runtime, "seen.summary.write", e); }
const othersFresh = sp.fresh;
const othersMutedLine = sp.muted.length ? sp.muted.length + " more item" + (sp.muted.length > 1 ? "s" : "") + " still waiting (shown earlier; my_inbox lists them)" : null;
// delivery receipts: human messages I sent that were read since the last time this hook reported them
const receipts = [];
if (myHandle && Array.isArray(peek?.sent)) {
  const rf = join(root, myHandle, "receipts-reported.json");
  let reported = []; try { reported = JSON.parse(readFileSync(rf, "utf8")); } catch {}
  const fresh = peek.sent.filter((m) => m.read_at && !reported.includes(m.id));
  if (fresh.length) {
    const byTo = new Map(); for (const m of fresh) { if (!byTo.has(m.to)) byTo.set(m.to, []); byTo.get(m.to).push(m); }
    for (const [to, list] of byTo) receipts.push(to + " read " + (list.length === 1 ? "your message: " + JSON.stringify((list[0].preview || "").slice(0, 50)) : list.length + " of your messages"));
    try { writeFileSync(rf, JSON.stringify([...reported.slice(-200), ...fresh.map((m) => m.id)])); } catch (e) { diag(root, runtime, "receipts.write", e); }
  }
}
// parked rows are hidden above but the server still counts them unread until the /ack lands
const n = Math.max(0, (peek?.unread_messages || 0) - parkedInPeek) + (peek?.proposals_awaiting_you || 0) + (peek?.artifacts_waiting || 0) + newFiles.length;
// A stale sibling handoff deliberately does NOT count toward n - inflating another runtime's count is the
// original bug - but it must not be silenced by n being zero either, or the one case this signal exists for
// (nothing else waiting, a handoff quietly rotting toward its 3-day delete) is the one case never reported.
const staleShown = othersFresh.some((l) => staleHandoffs.includes(l));
if (n === 0 && !receipts.length && !staleShown) finish(null);

// Rendering lives in lib/banner.mjs: pure, and therefore reachable by a test without spawning this script.
// What stays here is what has side effects - acquisition, the trust decision, seen-marking, acking.
const { human, agent, sys, codexBlock } = buildBanner({
  runtime, myHandle, n, humans, hands, repeats, newFiles,
  othersFresh, othersMutedLine, mutedCount: sp.muted.length, receipts,
});
if (!n && receipts.length) { if (runtime === "claude") finish({ systemMessage: sys }); }

// ack what we just displayed (the human has seen it - or, on Codex, will see it as the model's next reply).
// Claude Code renders the banner itself, so ack now; Codex parks the ids and the ack posts at the TOP of the
// next hook run, before anything is built (see above). Parked ids whose POST failed are carried forward so
// a network blip never drops a delivery. 2026-08-27: gate includes hands and repeats - a handoff with no
// human message alongside was never acked at all, and a repeat's ack must retry until the row is read.
if (humans.length || hands.length || repeats.length) {
  const shown = [...humans, ...hands, ...repeats].map((h) => h.id);
  if (runtime === "claude" || !pendingAckFile) { try { const ar = await fetch(url + "/ack", { method: "POST", headers: H, body: JSON.stringify({ ids: shown }), signal: AbortSignal.timeout(4000) }); if (!ar.ok) diag(root, runtime, "ack.post.status", "HTTP " + ar.status); } catch (e) { diag(root, runtime, "ack.post", e); } }
  else { try { writeFileSync(pendingAckFile, JSON.stringify([...new Set([...parkedRemaining, ...shown])])); } catch (e) { diag(root, runtime, "ack.park.write", e); } }
  // and rewrite the local peek without them so the next prompt does not repeat them before the listener refreshes
  if (myHandle) {
    try {
      const filtered = { ...peek, items: items.filter((i) => i.type !== "human" && !(i.type === "handoff" && i.for_this_runtime)), unread_messages: Math.max(0, (peek.unread_messages || 0) - parkedInPeek - humansAll.length - handsAll.length), summary: others };
      writeFileSync(join(root, myHandle, "peek.json"), JSON.stringify({ at: Date.now(), runtime, peek: filtered }));
    } catch {}
  }
}

finish({ systemMessage: sys, hookSpecificOutput: { hookEventName: eventName || "UserPromptSubmit", additionalContext: "[Agent Channel]\n" + agent.join("\n") } });
