#!/usr/bin/env node
// agent-channel <command> ...   the client, one entry point.
//   join <invite_code> <handle> "<Name>" [--runtime claude|codex|both] [--email you@x.com]
//   wire [--runtime ...] [--dry-run] [--oauth]        wire hooks / MCP / listener for an existing token
//   doctor                                             check everything for this machine
//   listen [--runtime claude|codex]                    run the resident listener in the foreground
//   send @handle <path> [--note ...]                   send a file end-to-end encrypted
//   share <path> | share --conversation [--last N] [--expires 72h] [--note ...]   make a read-only link (receiver installs nothing)
//   export-conversation [--last N] [--out file]       redacted transcript of the current Claude Code / Codex session
//   call <tool> '<json>'                              call any MCP tool (AGENTCHAN_TOKEN or saved token)
//   verify <contract_id> ...                          run the exit gate checks for a return
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const map = {
  join: ["scripts/setup.mjs", "join"], wire: ["scripts/setup.mjs", "wire"], doctor: ["scripts/setup.mjs", "doctor"],
  listen: ["scripts/listen.mjs"], send: ["scripts/artifact.mjs", "send"], fetch: ["scripts/artifact.mjs", "fetch"], keygen: ["scripts/artifact.mjs", "keygen"],
  share: ["scripts/share.mjs"], "export-conversation": ["scripts/export-conversation.mjs"], call: ["scripts/cli.mjs"], verify: ["scripts/verify.mjs"],
};
if (!cmd || !map[cmd]) {
  console.log(`agent-channel <command>

  join <invite_code> <handle> "<Name>" [--runtime claude|codex|both] [--email you@x.com]
  wire [--runtime claude|codex|desktop] [--dry-run] [--oauth]
  doctor
  listen [--runtime claude|codex]
  send @handle <path> [--note text]
  share <path> | share --conversation [--last N] [--expires 72h] [--note text]
  export-conversation [--last N] [--out file]
  call <tool> '<json args>'
  verify <contract_id> ...

Server: ${process.env.AGENTCHAN_URL || "https://agent-channel-production.up.railway.app"}   Tokens: ~/.agentchan/tok.<runtime>.json`);
  process.exit(cmd ? 1 : 0);
}
const [script, ...pre] = map[cmd];
if (cmd === "call" && !process.env.AGENTCHAN_TOKEN) {
  const { tokenFor } = await import("../lib/paths.mjs");
  const t = tokenFor(rest.includes("--runtime") ? rest[rest.indexOf("--runtime") + 1] : "claude");
  if (t) process.env.AGENTCHAN_TOKEN = t;
}
const child = spawn(process.execPath, [join(ROOT, script), ...pre, ...rest], { stdio: "inherit", env: process.env });
child.on("exit", (c) => process.exit(c ?? 1));
