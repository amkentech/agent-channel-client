#!/usr/bin/env node
// Hook: publish agent status to Agent Channel without an MCP round-trip.
//
//   node hooks/claude-status.mjs working                    SessionStart
//   node hooks/claude-status.mjs idle                       Stop
//   node hooks/claude-status.mjs offline                    SessionEnd
//   node hooks/claude-status.mjs working --runtime=codex    token for another runtime key (default: claude)
//
// `agent-channel wire` writes these into the runtime's settings (lib/adapters.mjs). By hand, in
// ~/.claude/settings.json, with <client> being wherever this package lives (a checkout, or ~/.agentchan/client):
//   "hooks": {
//     "SessionStart": [{ "hooks": [{ "type": "command", "command": "node <client>/hooks/claude-status.mjs working" }] }],
//     "Stop":         [{ "hooks": [{ "type": "command", "command": "node <client>/hooks/claude-status.mjs idle" }] }],
//     "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node <client>/hooks/claude-status.mjs offline" }] }]
//   }
//
// URL: AGENTCHAN_URL, else the public channel (lib/paths.mjs BASE). Token: the runtime's own env var, else its
// saved ~/.agentchan/tok.<runtime>.json (lib/paths.mjs tokenFor) -- the same resolver the other hooks use, so a
// machine that joined without pinning an env var still publishes. Silent no-op without a token, so an
// unconfigured machine never breaks a session. Reads the hook JSON on stdin for cwd. 4s timeout, never loud.

import { basename } from "node:path";
import { tokenFor, BASE } from "../lib/paths.mjs";

// argv: the state is positional (that is what every existing wiring passes); the runtime key is an optional
// --runtime=<key> or --runtime <key>, the same key=value style secret-guard.mjs takes its --deny-shape in.
const argv = process.argv.slice(2);
const positional = [];
let runtime = "claude";
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--runtime=")) runtime = a.slice("--runtime=".length);
  else if (a === "--runtime") runtime = argv[++i] || runtime;
  else if (!a.startsWith("--")) positional.push(a);
}
runtime = (runtime || "claude").toLowerCase();
const state = positional[0] || "working";
const url = BASE;
let token = null;
try { token = tokenFor(runtime); } catch {}
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
