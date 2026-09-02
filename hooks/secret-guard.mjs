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

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Same rule as lib/paths.mjs HOME_STORE, inlined so this hook stays dependency-free: AGENTCHAN_HOME relocates
// the store (a second identity on one machine, or a test that must not read the real credentials).
const HOME_STORE = process.env.AGENTCHAN_HOME || join(homedir(), ".agentchan");
const CONFIG = join(HOME_STORE, "secret-guard.json");

// Everything machine-specific lives in ~/.agentchan/secret-guard.json, never here: this file ships to strangers.
//   {
//     "sources": ["~/my-repo/.env.local", ...],        credential files whose values must never appear in argv
//     "scan_token_files": true,                        also guard the Agent Channel tokens in ~/.agentchan/tok.*.json
//     "unsafe_operations": [{ "id", "match", "unsafe", "reason" }, ...]   see below
//   }
// docs/secret-guard.example.json is a complete, working example.
const DEFAULT_SOURCES = [];

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
//
// Which operations do this is a property of the tools YOUR machine runs, so the list ships
// empty and is read from the config file's `unsafe_operations`:
//   { "id": "supabase-db-echo",
//     "match":  "(^|[\\s;&|(])(npx\\s+(--yes\\s+)?)?supabase\\s+db\\b",   the command family (regex source)
//     "unsafe": "(^|\\s)(--dry-run|--debug|--verbose|-v)(\\s|=|$)",        the mode that echoes (regex source)
//     "reason": "Blocked: ..." }
// A command is refused when BOTH regexes match (compiled case-insensitive). A negative lookahead
// expresses "unless": "^(?![\\s\\S]*--set)". A malformed regex skips that entry and blocks nothing.
const DEFAULT_UNSAFE_OPERATIONS = [];

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// Read once; a malformed file is treated as absent rather than guarding nothing at all.
let cfgCache;
function config() {
  if (cfgCache !== undefined) return cfgCache;
  cfgCache = null;
  try {
    if (existsSync(CONFIG)) {
      const c = JSON.parse(readFileSync(CONFIG, "utf8"));
      if (c && typeof c === "object" && !Array.isArray(c)) cfgCache = c;
    }
  } catch {
    // Malformed config: the built-in checks (2 and the token files) still run.
  }
  return cfgCache;
}

// A leading "~/" means the home directory, so one config file reads the same on every machine.
const expandHome = (p) => (/^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);

function sources() {
  const cfg = config();
  if (Array.isArray(cfg?.sources)) return cfg.sources.filter((s) => typeof s === "string" && s).map(expandHome);
  return DEFAULT_SOURCES;
}

function unsafeOperations() {
  const cfg = config();
  const list = Array.isArray(cfg?.unsafe_operations) ? cfg.unsafe_operations : DEFAULT_UNSAFE_OPERATIONS;
  const out = [];
  list.forEach((e, i) => {
    if (!e || typeof e !== "object" || typeof e.match !== "string" || typeof e.unsafe !== "string") return;
    const id = typeof e.id === "string" && e.id ? e.id : "unsafe-operation-" + i;
    try {
      const match = new RegExp(e.match, "i");
      const unsafe = new RegExp(e.unsafe, "i");
      out.push({
        id,
        match,
        unsafe: (c) => unsafe.test(c),
        reason: typeof e.reason === "string" && e.reason
          ? e.reason
          : "Blocked by secret-guard rule '" + id + "' in " + CONFIG + " (the rule gives no reason).",
      });
    } catch {
      // A regex that does not compile is a config mistake, not a reason to block or to crash.
    }
  });
  return out;
}

// A short value would match everywhere and make the guard useless noise.
const MIN_SECRET_LEN = 12;

// The Agent Channel tokens themselves: every user has them, they are bearer credentials, and they cost one
// readdir to find. Off with "scan_token_files": false in the config. Only the home store is scanned; the
// legacy in-repo .tok files are not, so a relocated store (AGENTCHAN_HOME) never reaches outside itself.
function tokenFileSecrets() {
  const out = [];
  if (config()?.scan_token_files === false) return out;
  try {
    for (const f of readdirSync(HOME_STORE)) {
      if (!/^tok\..+\.json$/i.test(f)) continue;
      const path = join(HOME_STORE, f);
      try {
        if (statSync(path).size > 64 * 1024) continue;
        const tok = JSON.parse(readFileSync(path, "utf8"))?.token;
        if (typeof tok === "string" && tok.length >= MIN_SECRET_LEN) out.push({ value: tok, path, key: "token" });
      } catch {
        // Unreadable or not JSON: not a reason to block the command.
      }
    }
  } catch {
    // No store yet (nothing joined): nothing to guard.
  }
  return out;
}

function secrets() {
  const out = tokenFileSecrets();
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

// Two runtimes, two blocking contracts, and getting this wrong is silent.
//
// Claude Code reads hookSpecificOutput.permissionDecision. Gemini CLI reads a TOP-LEVEL `decision`:
// isBlockingDecision() { return this.decision === "block" || this.decision === "deny" }. The string
// "permissionDecision" does not appear anywhere in the gemini 0.56.0 bundle, so a Claude-shaped refusal is
// parsed, found non-blocking, and the command runs -- while doctor reports the guard as wired and
// supportsPreExec suppresses the warning that would have disclosed it. A guard that reports success and lets
// the secret through is worse than no guard, which is the whole reason this file exists.
//
// Both keys are emitted together: they occupy different levels of the same object, each runtime reads its own,
// and neither sees a field it does not understand. Verified against both bundles rather than assumed.
// Two runtimes, two incompatible refusal shapes, and picking wrong fails SILENTLY in both directions.
//
// Claude Code reads hookSpecificOutput.permissionDecision. Gemini CLI reads a TOP-LEVEL `decision`:
// isBlockingDecision() { return this.decision === "block" || this.decision === "deny" }, and the string
// "permissionDecision" appears nowhere in the gemini 0.56.0 bundle -- so a Claude-shaped refusal is parsed,
// found non-blocking, and the command runs.
//
// The obvious fix, emitting both keys at once, was tested live on 2026-08-27 and is WRONG: with a top-level
// `decision: "deny"` present, Claude Code discarded the entire hook output and ran the command. ("deny" is not
// one of its accepted top-level values.) Same command, field removed, blocked. So the shape is exclusive, and
// the wrong guess disables the guard on whichever runtime you were not testing.
//
// The shape therefore travels on argv from lib/adapters.mjs (--deny-shape=decision), because the adapter is
// where a runtime's contract belongs. No runtime name appears in this file: a new runtime is an adapter entry.
const DENY_SHAPE = (process.argv.find((a) => a.startsWith("--deny-shape=")) || "").split("=")[1] || "permission";

function deny(reason) {
  process.stdout.write(
    JSON.stringify(
      DENY_SHAPE === "decision"
        ? { decision: "deny", reason }
        : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    )
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

// Claude Code, Codex and Gemini send the stdin envelope in snake_case; grok 1.0.5 sends the SAME fields in
// camelCase throughout (`toolInput`, `hookEventName`, `stopHookActive`, and `toolResult` where Claude has
// `tool_response`) -- read out of the shipped hook reference in grok.exe, which lists it as the first porting
// difference. Reading only `tool_input` there yields undefined, this file exits 0, and every command runs
// while doctor reports the guard as wired and supportsPreExec suppresses the warning: the silent-success
// failure the comment above exists to prevent, arriving through the payload instead of the refusal shape.
// Accept both spellings rather than branch on a runtime name; a runtime is an adapter entry, not an if.
const command = (input?.tool_input ?? input?.toolInput)?.command;
if (typeof command !== "string" || !command) process.exit(0);

for (const s of secrets()) {
  if (command.includes(s.value)) {
    const label = s.key ? `${s.key} (from ${s.path})` : s.path;
    deny(
      `Blocked: this command contains the live credential ${label} as literal text. ` +
        `A secret on a command line is captured by shell history, npm/CLI argv logs, and this tool's own output, ` +
        `which is how it reaches a model provider. Pass it through an environment variable or stdin instead ` +
        `(for example: 'railway variables --set-from-stdin KEY', or export PGPASSWORD and drop the --password flag). ` +
        `If the value genuinely must be inline, ask the person you work for to run the command themselves.`
    );
  }
}

for (const op of unsafeOperations()) {
  if (op.match.test(command) && op.unsafe(command)) deny(op.reason);
}

const m = command.match(SECRET_FLAGS);
if (m && !PLACEHOLDER.test(m[4]) && m[4].length >= 8) {
  deny(
    `Blocked: '--${m[2]}' is given an inline value. Credentials on a command line end up in argv logs and in ` +
      `tool output that leaves the machine. Use an environment variable or stdin, or have the person you work for run it directly.`
  );
}

process.exit(0);
