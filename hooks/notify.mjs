#!/usr/bin/env node
// Claude Code FileChanged hook: fires the moment the resident listener writes ~/.agentchan/<handle>/agentchan_notify,
// even while the session is idle. Prints the event as a terminal notification (systemMessage) + a BEL. No model turn.
//   settings.json:  "FileChanged": [{ "matcher": "agentchan_notify", "hooks": [{ "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/notify.mjs claude" }] }]
//   The SessionStart hook (inbox.mjs) registers the watch path for this runtime's handle.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const runtime = (process.argv[2] || "claude").toLowerCase();
const root = join(homedir(), ".agentchan");
let handle = null;
try { for (const h of readdirSync(root)) { try { if (readFileSync(join(root, h, "owner." + runtime), "utf8") === "1") handle = h; } catch {} } } catch {}
if (!handle) process.exit(0);
let line = "";
try { line = readFileSync(join(root, handle, "agentchan_notify"), "utf8").trim(); } catch {}
if (!line) process.exit(0);
process.stdout.write(JSON.stringify({ systemMessage: "[Agent Channel] " + line, terminalSequence: "\u0007" }));
