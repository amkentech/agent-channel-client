// Is the client copy the hooks run from older than the last released client?
//
// 2026-09-29: the hooks on the developer's machine ran from ~/.agentchan/client at 0.8.0 (copied 2026-08-26) while npm
// had 0.9.0, so the show-once handoff fix never reached him and the same handoffs re-rendered on every prompt for
// hours. Nothing said the copy was stale. The server now reports `client_latest` (from client/package.json, which
// scripts/release-client.mjs bumps in the release commit) on /peek and /status; the SessionStart hook and doctor
// compare it with the version of the copy they are looking at. Pure functions, no I/O beyond reading a package.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `join`/`wire` run from an npx cache copy this package into CLIENT_HOME and repoint the hooks there (scripts/setup.mjs);
// @latest makes npx resolve the registry instead of reusing a cached older copy.
export const UPDATE_CMD = "npx @amkentech/agent-channel@latest wire";

const parse = (v) => {
  const m = String(v || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(-[\w.]+)?$/);
  return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: !!m[4] } : null;
};

/** -1 / 0 / 1, or null when either side is not a version. A prerelease sorts below its release. */
export function cmpVersion(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre !== y.pre) return x.pre ? -1 : 1;
  return 0;
}

/** The version in <root>/package.json, or null. */
export function versionAt(root) {
  try { return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version || null; } catch { return null; }
}

/** One line for the human and one for the agent when `running` is older than `latest`; null otherwise (equal, newer,
 *  or either side unknown -- an old server that sends no field says nothing). */
export function staleClientNotice(running, latest) {
  if (cmpVersion(running, latest) !== -1) return null;
  const line = "Agent Channel client " + running + " is older than " + latest + " — run `" + UPDATE_CMD + "` to update";
  return { human: "[Agent Channel] " + line, agent: line + ". Hook fixes in newer releases are not active in this session until then; tell the user once." };
}

/** Client roots (the folder holding hooks/) that a host config's commands run inbox.mjs from. */
export function clientRootsInHooks(text) {
  let j; try { j = JSON.parse(text); } catch { return []; }
  const roots = new Set();
  const walk = (v) => {
    if (typeof v === "string") {
      const m = v.match(/(?:^|\s)(?:"([^"]+?)|([^\s"]+?))[\\/]hooks[\\/]inbox\.mjs/);
      if (m && (m[1] || m[2])) roots.add(m[1] || m[2]);
    } else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  walk(j);
  return [...roots];
}
