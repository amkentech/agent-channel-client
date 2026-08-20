// Where the client keeps things, independent of where the code runs from.
//
// The client (hooks, listener, setup, artifact, share) can run from a git checkout of the repo, from a global install, from
// the persistent copy `setup.mjs join` makes under ~/.agentchan/client, or from an npx cache that vanishes. Tokens therefore
// live in the HOME store, not next to the code:
//     ~/.agentchan/tok.<runtime>.json        { token, runtime, base, handle }   (0600 where the OS honours it)
// with the old in-repo `.tok.<runtime>.json` still read as a fallback so existing installs keep working.
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const HOME_STORE = join(homedir(), ".agentchan");
export const CLIENT_HOME = join(HOME_STORE, "client");          // persistent copy of the client package (setup.mjs join)
export const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");   // wherever this code runs from
export const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
export const IN_NPX_CACHE = /[\\/]_npx[\\/]|[\\/]\.npm[\\/]_cacache|[\\/]npm-cache[\\/]/i.test(CLIENT_ROOT);

export const tokFileHome = (key) => join(HOME_STORE, "tok." + key + ".json");
export const tokFileRepo = (key) => join(CLIENT_ROOT, ".tok." + key + ".json");

const parseTok = (t) => { try { return JSON.parse(t); } catch { const m = t.match(/"token"\s*:\s*"([^"]+)"/); return m ? { token: m[1], handle: t.match(/"(?:person|handle)"\s*:\s*"([^"]+)"/)?.[1] } : null; } };

/** Read the saved token record for a runtime key (claude | codex | claude-desktop), home store first, then the repo file. */
export function readTok(key) {
  for (const f of [tokFileHome(key), tokFileRepo(key), join(homedir(), "agent-channel", ".tok." + key + ".json")]) {
    try { if (existsSync(f)) { const r = parseTok(readFileSync(f, "utf8")); if (r?.token) return { ...r, file: f }; } } catch {}
  }
  return null;
}
export function saveTok(key, obj) {
  mkdirSync(HOME_STORE, { recursive: true });
  const f = tokFileHome(key);
  writeFileSync(f, JSON.stringify(obj, null, 2));
  try { chmodSync(f, 0o600); } catch {}
  return f;
}
/** Token for a runtime: env first (AGENTCHAN_TOKEN / AGENTCHAN_CODEX_TOKEN), then the saved record. */
export function tokenFor(key) {
  const k = String(key || "claude").toLowerCase();
  const env = k === "codex" ? (process.env.AGENTCHAN_CODEX_TOKEN || null) : (process.env.AGENTCHAN_TOKEN || null);
  if (env) return env;
  const r = readTok(k) || (k === "claude-desktop" ? readTok("claude") : null);
  return r?.token || null;
}
