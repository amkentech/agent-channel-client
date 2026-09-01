// Where the client keeps things, independent of where the code runs from.
//
// The client (hooks, listener, setup, artifact, share) can run from a git checkout of the repo, from a global install, from
// the persistent copy `setup.mjs join` makes under ~/.agentchan/client, or from an npx cache that vanishes. Tokens therefore
// live in the HOME store, not next to the code:
//     ~/.agentchan/tok.<runtime>.json        { token, runtime, base, handle }   (0600 where the OS honours it)
// with the old in-repo `.tok.<runtime>.json` still read as a fallback so existing installs keep working.
import { homedir, platform } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { adapterFor } from "./adapters.mjs";

// AGENTCHAN_HOME relocates the whole token store. It means "the store is exactly here" -- a second identity on
// one machine, or a test that must not be able to read the developer's real credentials. Setting it therefore
// also switches OFF the legacy fallbacks below (the in-repo .tok file and ~/agent-channel): a relocated store
// that still reaches into the source checkout is not a relocated store, and a sandbox that reaches into it is
// not a sandbox. setup.mjs additionally declines to setx under it, because a secondary store must never be
// pinned into the machine's user environment.
export const RELOCATED = !!process.env.AGENTCHAN_HOME;
export const HOME_STORE = process.env.AGENTCHAN_HOME || join(homedir(), ".agentchan");
export const CLIENT_HOME = join(HOME_STORE, "client");          // persistent copy of the client package (setup.mjs join)
export const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");   // wherever this code runs from
export const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
export const IN_NPX_CACHE = /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_cacache|[\\/]npm-cache[\\/]/i.test(CLIENT_ROOT);

export const tokFileHome = (key) => join(HOME_STORE, "tok." + key + ".json");
export const tokFileRepo = (key) => join(CLIENT_ROOT, ".tok." + key + ".json");

const parseTok = (t) => { try { return JSON.parse(t); } catch { const m = t.match(/"token"\s*:\s*"([^"]+)"/); return m ? { token: m[1], handle: t.match(/"(?:person|handle)"\s*:\s*"([^"]+)"/)?.[1] } : null; } };

/** Read the saved token record for a runtime key (claude | codex | claude-desktop), home store first, then the repo file. */
export function readTok(key) {
  const legacy = RELOCATED ? [] : [tokFileRepo(key), join(homedir(), "agent-channel", ".tok." + key + ".json")];
  for (const f of [tokFileHome(key), ...legacy]) {
    try { if (existsSync(f)) { const r = parseTok(readFileSync(f, "utf8")); if (r?.token) return { ...r, file: f }; } } catch {}
  }
  return null;
}
export function saveTok(key, obj, envOpts) {
  mkdirSync(HOME_STORE, { recursive: true });
  const f = tokFileHome(key);
  writeFileSync(f, JSON.stringify(obj, null, 2));
  try { chmodSync(f, 0o600); } catch {}
  // Every writer refreshes a matching user env var in the same motion. The two stores drifting is not
  // hypothetical: setup.mjs pinned tokens with setx at wire time, later remints rewrote only this file, and
  // tokenFor() (env-first) fed the dead env token to the hooks -- every /peek and /ack 401'd for nine hours
  // (2026-08-28, diag-claude.jsonl). Non-force: only an env var that already EXISTS is updated, so an anon
  // share token or a first save never pins anything wire did not decide to pin.
  if (obj?.token && !obj.anon) { try { refreshTokenEnv(key, obj.token, envOpts); } catch {} }
  return f;
}

/** The saved-record token only, never the environment. The self-heal paths need to know what the tok file
 *  holds SEPARATELY from what tokenFor() (env-first) answered. Mirrors tokenFor's claude-desktop fallback. */
export function fileTokenFor(key) {
  const k = String(key || "claude").toLowerCase();
  const r = readTok(k) || (k === "claude-desktop" ? readTok("claude") : null);
  return r?.token || null;
}

/** Windows: put `token` into the runtime's per-user env var without the token ever entering a command line
 *  (argv is visible to other processes and to agent tool output; setx was the leak this replaces). The value
 *  travels in the CHILD's environment and PowerShell reads it back out of $env:.
 *  Non-force refreshes only a variable that already exists (drift repair on every save); force sets it
 *  unconditionally (wire's explicit pin). A relocated store (AGENTCHAN_HOME) is never pinned into the
 *  machine's environment -- same rule the setx call enforced.
 *  Returns { ok, state } with state one of set | updated | current | absent | skipped. */
export function refreshTokenEnv(key, token, { force = false, exec = execFileSync, win = platform() === "win32", relocated = RELOCATED } = {}) {
  if (!win) return { ok: true, state: "skipped", why: "not windows" };
  if (relocated) return { ok: true, state: "skipped", why: "AGENTCHAN_HOME is set; a secondary store is never pinned into the user environment" };
  const name = tokenEnvFor(key);
  if (!token || !name) return { ok: false, why: "no token or env name" };
  const script =
    "$n=$env:AC_ENV_NAME; $v=$env:AC_ENV_VALUE; " +
    "$cur=[Environment]::GetEnvironmentVariable($n,'User'); " +
    "if ([string]::IsNullOrEmpty($cur)) { if ($env:AC_ENV_FORCE -eq '1') { [Environment]::SetEnvironmentVariable($n,$v,'User'); 'set' } else { 'absent' } } " +
    "elseif ($cur -ceq $v) { 'current' } " +
    "else { [Environment]::SetEnvironmentVariable($n,$v,'User'); 'updated' }";
  try {
    const outRaw = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, AC_ENV_NAME: name, AC_ENV_VALUE: token, AC_ENV_FORCE: force ? "1" : "0" },
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, windowsHide: true,
    });
    const state = String(outRaw || "").trim();
    if (["set", "updated", "current", "absent"].includes(state)) return { ok: true, state };
    return { ok: false, why: "unexpected output" };
  } catch (e) { return { ok: false, why: e.message?.slice(0, 120) || "spawn failed" }; }
}
/** Token for a runtime: the runtime's OWN env var first, then the saved record.
 *
 *  This used to read `k === "codex" ? AGENTCHAN_CODEX_TOKEN : AGENTCHAN_TOKEN`, which quietly handed every
 *  runtime except Codex the Claude Code agent's token. That was survivable while only two runtimes ran hooks and
 *  the rest were MCP-only. It stopped being survivable the moment /peek and /ack began scoping unread mail by
 *  the requesting agent's runtime: a Gemini hook on a machine with AGENTCHAN_TOKEN set would authenticate AS
 *  claude-code, see Claude Code's handoffs, and ack them -- the mail would be gone before the session it was
 *  addressed to ever ran. The env var is now the adapter's declared tokenEnv, so adding a runtime is still one
 *  entry in ADAPTERS and nothing here needs to know its name. */
export function tokenFor(key) {
  const k = String(key || "claude").toLowerCase();
  const env = process.env[tokenEnvFor(k)];
  if (env) return env;
  const r = readTok(k) || (k === "claude-desktop" ? readTok("claude") : null);
  return r?.token || null;
}

/** The env var a runtime reads its token from, per lib/adapters.mjs. Unknown keys resolve through adapterFor()
 *  to the `generic` adapter, which has its own variable -- deliberately NOT Claude Code's. */
export function tokenEnvFor(key) {
  return adapterFor(key)?.tokenEnv || "AGENTCHAN_OTHER_TOKEN";
}

// Quoting, done by the rules of the shell that will actually run the line. The previous hint was a bash
// `export` printed on every platform (it is not a command on Windows) that embedded the token file's path
// inside a JS string literal inside a double-quoted `node -e`, so a home directory containing an apostrophe --
// C:\Users\Ronan O'Brien -- produced a line that could not parse. The path now travels as an ARGUMENT rather
// than as source code, which removes one level of quoting entirely, and what remains is escaped properly.
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";   // POSIX: close, escaped quote, reopen
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";      // PowerShell: doubled

/** How to put a saved token into this shell's environment, without ever printing the token.
 *  Returns { shell, read, command }: `read` is the expression that extracts the token from the file (safe to
 *  execute on its own, which is how it is tested), `command` is the whole line to paste. */
export function tokenEnvHint(key, { os = platform(), file = tokFileHome(key), env = tokenEnvFor(key) } = {}) {
  if (os === "win32") {
    const read = "((Get-Content -Raw " + psQuote(file) + " | ConvertFrom-Json).token)";
    return { shell: "powershell", read, command: "setx " + env + " " + read };
  }
  const script = 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)';
  const read = "node -e " + shQuote(script) + " " + shQuote(file);
  return { shell: "sh", read, command: "export " + env + '="$(' + read + ')"' };
}
