#!/usr/bin/env node
// Claude Code FileChanged hook: fires the moment the resident listener writes ~/.agentchan/<handle>/agentchan_notify,
// even while the session is idle. Prints the event as a terminal notification (systemMessage) + a BEL. No model turn.
//   settings.json:  "FileChanged": [{ "matcher": "agentchan_notify", "hooks": [{ "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/notify.mjs claude" }] }]
//   The SessionStart hook (inbox.mjs) registers the watch path for this runtime's handle.
//
// Session isolation (2026-09-27, lib/claim.mjs): every session registered the watch, so every session beeped. Now
// the notice shows only in the session the event routes to (its thread's session, else home); a muted session is
// silent; a handoff addressed to another runtime (including one this session just sent) is not an arrival. When
// no session holds the route (home idle 30+ minutes), it falls back to the old behaviour rather than go silent.
// A host with no session_id also keeps the old behaviour.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { rtKey, readClaims, readSession, routeFor, threadOfItem } from "../lib/claim.mjs";

const runtime = (process.argv[2] || "claude").toLowerCase();
const root = process.env.AGENTCHAN_HOME || join(homedir(), ".agentchan");
let input = {};
try {
  const raw = await new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    const c = []; let done = false;
    const fin = () => { if (!done) { done = true; res(Buffer.concat(c).toString("utf8")); } };
    process.stdin.on("data", (d) => c.push(d)); process.stdin.on("end", fin); process.stdin.on("error", fin);
    setTimeout(fin, 300).unref();
  });
  if (raw) input = JSON.parse(raw);
} catch {}
let handle = null;
try { for (const h of readdirSync(root)) { try { if (readFileSync(join(root, h, "owner." + runtime), "utf8").trim() === "1") handle = h; } catch {} } } catch {}
if (!handle) process.exit(0);
let line = "";
try { line = readFileSync(join(root, handle, "agentchan_notify"), "utf8").trim(); } catch {}
if (!line) process.exit(0);

const sid = typeof input.session_id === "string" && input.session_id ? input.session_id : null;
if (sid) {
  if (readSession(root, handle, runtime, sid).muted) process.exit(0);
  // the notify file is free text; the event it announces is the last line the listener appended
  let ev = null;
  try { const ls = readFileSync(join(root, handle, "events.jsonl"), "utf8").split("\n").filter((l) => l.trim()); ev = JSON.parse(ls[ls.length - 1]); } catch {}
  if (ev) {
    if (ev.type === "handoff" && ev.for_runtime && rtKey(ev.for_runtime) !== rtKey(runtime)) process.exit(0);
    const dest = routeFor(readClaims(root, handle, runtime), threadOfItem(ev, handle));
    if (dest && dest !== sid) process.exit(0);
  }
}
process.stdout.write(JSON.stringify({ systemMessage: "[Agent Channel] " + line, terminalSequence: "\u0007" }));
