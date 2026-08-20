#!/usr/bin/env node
// Claude Code hook: publish agent status to Agent Channel without an MCP round-trip.
// Wire in ~/.claude/settings.json:
//   "hooks": {
//     "SessionStart": [{ "hooks": [{ "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/claude-status.mjs working" }] }],
//     "Stop":         [{ "hooks": [{ "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/claude-status.mjs idle" }] }],
//     "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/claude-status.mjs offline" }] }]
//   }
// Reads AGENTCHAN_URL and AGENTCHAN_TOKEN from the environment. Silent no-op if either is missing,
// so an unconfigured machine never breaks a session. Reads the hook JSON on stdin for cwd.

import { basename } from "node:path";

const state = process.argv[2] || "working";
const url = (process.env.AGENTCHAN_URL || "").replace(/\/mcp$/, "");
const token = process.env.AGENTCHAN_TOKEN;
if (!url || !token) process.exit(0);

let cwd = process.cwd();
try {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const j = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (j.cwd) cwd = j.cwd;
} catch {}

const body = { state, repo: basename(cwd), task: state === "working" ? "session active in " + basename(cwd) : undefined };
try {
  await fetch(url + "/status", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
} catch {}
process.exit(0);
