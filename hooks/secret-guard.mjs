#!/usr/bin/env node
// PreToolUse guard: refuse shell commands that carry a live credential on the
// command line.
//
// Why this exists: on 2026-08-22 an agent ran
//   npx supabase db dump --project-ref <ref> --password <the real password>
// The password landed in npm's argv log and in the agent's own tool output,
// which meant it left the machine into a model provider's context. Keeping the
// secret out of Git was necessary and not sufficient -- argv is a disclosure
// channel too.
//
// Three checks, cheapest first:
//   1. Literal match against the values in known credential files.
//   2. Secret-bearing flags (--password, --token, ...) given an inline value.
//   3. Operations known to print a credential they were merely given, where a clean
//      command line proves nothing because the leak happens on the way out.
//
// A block here is advisory to the model, not a security boundary: it stops the
// accident, not an adversary. Exit 0 always -- a crashing hook must not wedge
// the session.

import { readFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG = join(homedir(), ".agentchan", "secret-guard.json");

const DEFAULT_SOURCES = [
  join(homedir(), "agent-channel", ".dbpw"),
  join(homedir(), "agent-channel", ".env.local"),
];

// Flags whose value is a credential often enough that an inline literal is
// always the wrong call: pass these through an env var or stdin instead.
const SECRET_FLAGS =
  /(^|\s)--?(password|passwd|pwd|token|api[-_]?key|secret|access[-_]?key|auth[-_]?token)(\s+|=)(\S+)/i;

// Values that are obviously not a real secret, so the flag check stays quiet
// for docs, examples, and correct env-var indirection.
const PLACEHOLDER =
  /^(\$|%|<|"?\$\{|['"]?\s*$|xxx|yyy|placeholder|your[-_]|example|redacted|\*+$|\.\.\.)/i;

// Operations with known credential-disclosure behaviour. Checks 1 and 2 both assume the
// secret is visible in the command being run; these are the cases where it is not. On
// 2026-08-22 Supabase CLI v2.115.0 expanded PGPASSWORD into a generated shell script and
// printed it in --dry-run output: argv was clean, the credential still left the machine,
// because tool output is a disclosure channel too.
//
// Blocking the mode is cruder than redacting the value, but redaction is not available to
// us: a PostToolUse hook can only append context, never replace a tool result, so by the
// time the secret is printed it is already in the transcript. PreToolUse is the last point
// that still runs before the process does. Each entry names its own escape hatch.
const UNSAFE_OPERATIONS = [
  {
    id: "supabase-db-echo",
    // `supabase db ...` in any mode whose whole job is to print what it would have done.
    match: /(^|[\s;&|(])(npx\s+(--yes\s+)?)?supabase\s+db\b/i,
    unsafe: (c) => /(^|\s)(--dry-run|--debug|--verbose|-v)(\s|=|$)/i.test(c),
    reason:
      "Blocked: 'supabase db' in a dry-run/debug/verbose mode. This CLI has printed the " +
      "database password it resolved (v2.115.0 expanded PGPASSWORD into a generated script " +
      "and echoed it), so the credential reaches tool output even when the command line is " +
      "clean. Run it without the preview flag, redirect the output to a gitignored file " +
      "instead of returning it, or ask Johnathan to run it himself.",
  },
  {
    id: "railway-variables-read",
    // A bare listing prints every value in the environment, ADMIN_KEY and DATABASE_URL included.
    match: /(^|[\s;&|(])railway\s+variables\b/i,
    unsafe: (c) => !/(^|\s)--set/i.test(c),
    reason:
      "Blocked: 'railway variables' without --set prints every value in the service " +
      "environment, which here includes ADMIN_KEY and DATABASE_URL. Reading them into tool " +
      "output discloses them. Use 'railway variables --set-from-stdin KEY' to write, or ask " +
      "Johnathan to read them himself.",
  },
];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function sources() {
  if (existsSync(CONFIG)) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
      if (Array.isArray(cfg.sources)) return cfg.sources;
    } catch {
      // Malformed config: fall through to defaults rather than guarding nothing.
    }
  }
  return DEFAULT_SOURCES;
}

// A short value would match everywhere and make the guard useless noise.
const MIN_SECRET_LEN = 12;

function secrets() {
  const out = [];
  for (const path of sources()) {
    try {
      if (!existsSync(path) || statSync(path).size > 64 * 1024) continue;
      const raw = readFileSync(path, "utf8");
      // Bare-value files (.dbpw) and KEY=value files (.env) both appear here.
      for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const eq = t.indexOf("=");
        const value = (eq === -1 ? t : t.slice(eq + 1)).trim().replace(/^["']|["']$/g, "");
        if (value.length >= MIN_SECRET_LEN) out.push({ value, path, key: eq === -1 ? null : t.slice(0, eq) });
      }
    } catch {
      // Unreadable source is not a reason to block the command.
    }
  }
  return out;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

let input;
try {
  // Strip a leading BOM: some shells add one when piping, and JSON.parse throws on it.
  input = JSON.parse(readStdin().replace(/^﻿/, "") || "{}");
} catch {
  process.exit(0);
}

const command = input?.tool_input?.command;
if (typeof command !== "string" || !command) process.exit(0);

for (const s of secrets()) {
  if (command.includes(s.value)) {
    const label = s.key ? `${s.key} (from ${s.path})` : s.path;
    deny(
      `Blocked: this command contains the live credential ${label} as literal text. ` +
        `A secret on a command line is captured by shell history, npm/CLI argv logs, and this tool's own output, ` +
        `which is how it reaches a model provider. Pass it through an environment variable or stdin instead ` +
        `(for example: 'railway variables --set-from-stdin KEY', or export PGPASSWORD and drop the --password flag). ` +
        `If the value genuinely must be inline, ask Johnathan to run the command himself.`
    );
  }
}

for (const op of UNSAFE_OPERATIONS) {
  if (op.match.test(command) && op.unsafe(command)) deny(op.reason);
}

const m = command.match(SECRET_FLAGS);
if (m && !PLACEHOLDER.test(m[4]) && m[4].length >= 8) {
  deny(
    `Blocked: '--${m[2]}' is given an inline value. Credentials on a command line end up in argv logs and in ` +
      `tool output that leaves the machine. Use an environment variable or stdin, or have Johnathan run it directly.`
  );
}

process.exit(0);
