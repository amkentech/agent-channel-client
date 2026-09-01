#!/usr/bin/env node
// agent-channel <command> ...   the client, one entry point.
//   init                                               detect every agent CLI, register into each, verify
//   join <invite_code> <handle> "<Name>" [--runtime claude|codex|grok|all] [--email you@x.com]
//   signin <handle> [--runtime ...]                    existing identity, new machine/runtime (emailed code, no invite)
//   wire [--runtime ...] [--dry-run] [--oauth]        wire hooks / MCP / listener for an existing token
//   doctor                                             check everything for this machine
//   listen [--runtime claude|codex]                    run the resident listener in the foreground
//   send @handle <path> [--note ...]                   send a file end-to-end encrypted
//   share <path> | share --conversation [--last N] [--expires 72h] [--note ...]   make a read-only link (receiver installs nothing)
//   export-conversation [--last N] [--out file]       redacted transcript of the current Claude Code / Codex session
//   call <tool> '<json>' [--runtime <key>]            call any MCP tool as that runtime's own agent
//   verify <contract_id> ... [--runtime <key>]        run the exit gate checks for a return
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [cmd, ...rest] = process.argv.slice(2);
const map = {
  init: ["scripts/setup.mjs", "init"], join: ["scripts/setup.mjs", "join"], signin: ["scripts/setup.mjs", "signin"], wire: ["scripts/setup.mjs", "wire"], doctor: ["scripts/setup.mjs", "doctor"],
  listen: ["scripts/listen.mjs"], send: ["scripts/artifact.mjs", "send"], fetch: ["scripts/artifact.mjs", "fetch"], keygen: ["scripts/artifact.mjs", "keygen"],
  rotate: ["scripts/artifact.mjs", "rotate"], "revoke-key": ["scripts/artifact.mjs", "revoke-key"], keys: ["scripts/artifact.mjs", "keys"],
  share: ["scripts/share.mjs"], publish: ["scripts/publish.mjs"], open: ["scripts/open-link.mjs"], "export-conversation": ["scripts/export-conversation.mjs"], call: ["scripts/cli.mjs"], verify: ["scripts/verify.mjs"],
  "audit-verify": ["scripts/audit-verify.mjs"], guide: ["scripts/guide.mjs"],
};
if (!cmd || !map[cmd]) {
  console.log(`agent-channel <command>

  init                                            detect every agent CLI on this machine, register into each, verify
  join <invite_code> <handle> "<Name>" [--runtime claude|codex|grok|all] [--email you@x.com]
  signin <handle> [--runtime ...]                 existing identity, new machine or runtime: code to your verified email
  wire [--runtime claude|codex|desktop|cursor|gemini|windsurf|grok|all] [--dry-run] [--oauth]
  doctor
  listen [--runtime claude|codex]
  send @handle <path> [--note text]
  share <path> | share --conversation [--last N] [--expires 72h] [--note text]
  publish <path|dir> --as <slug> [--title "..."]   stable URL: republish the same slug and the SAME link updates
  publish --list | --url <slug> | --touch <slug> | --revoke <slug>
  open "<share link>" [--out file] [--print]      decrypt a share or doc link locally; no hosted viewer, no account
  open --check [--json]                           docs you have read that moved since you read them
  rotate [--label x]                              new E2E key registered, old one revoked (kept locally, retired)
  revoke-key <key_id> | --all                     lost device: revoke its key from any other machine of yours
  keys [@handle]                                  registered public keys with fingerprints
  export-conversation [--last N] [--out file]
  call <tool> '<json args>' [--runtime <key>]     any MCP tool, as that runtime's own agent (default claude)
  verify <contract_id> ... [--runtime <key>]
  audit-verify [--record] <export.json>           offline: recheck a signed export's hashes, chain, signature
  guide [topic]                                   what this channel can do, by job (share, publish, handoff, teams, ...)

Server: ${process.env.AGENTCHAN_URL || "https://channel.amkentech.com"}   Tokens: ~/.agentchan/tok.<runtime>.json`);
  process.exit(cmd ? 1 : 0);
}
const [script, ...pre] = map[cmd];
// No token resolution here any more. This used to resolve one for `call` and hand it to the child in
// AGENTCHAN_TOKEN -- Claude Code's variable -- whatever runtime had been asked for, which is the same
// borrowed-identity shape lib/paths.mjs exists to prevent; and it only did so when AGENTCHAN_TOKEN was UNSET,
// so on a machine wired for Claude Code (the normal case) `call --runtime codex` fell straight through and ran
// as claude-code. cli.mjs and verify.mjs now resolve their own token from the runtime they were given, so the
// saved-token path this provided is still there, one layer down, and correct for every runtime.
const child = spawn(process.execPath, [join(ROOT, script), ...pre, ...rest], { stdio: "inherit", env: process.env });
child.on("exit", (c) => process.exit(c ?? 1));
