// Commit-time sightings (docs/RECEIPTS.md "Closing the gap", layer 1).
//
// Run by the post-commit hook. Reads which runtime-marker env var NAMES are present (lib/agent-runtimes.json).
// None present -> nothing happens, no network. Otherwise it names the innermost runtime and POSTs
// { repo, sha, patch_id, innermost, session_id, markers } to /sightings.
//
// Innermost rule. Markers inherit into nested sessions (a Codex launched from a Claude Code shell carries CLAUDECODE,
// AI_AGENT and CLAUDE_CODE_SESSION_ID as well as its own), so "which markers are present" does not say who is
// committing. The rule: a runtime is a candidate when one of its identity_vars is present (session-id variable
// first; Gemini exposes no session id, so its constant GEMINI_CLI stands in; AI_AGENT alone never identifies
// anything). Among candidates the first in innermost_priority wins: the more specific non-Claude runtimes before
// Claude Code, because Claude Code is the one observed leaking into children. Known limit: Claude Code launched
// FROM Codex would be named Codex. The sighting still records every marker name present, so a reviewer sees both.
//
// What is sent: marker NAMES only. The one value that leaves the machine is the innermost runtime's session id,
// because the wire contract's `session_id` field is that id (it is what lets a sighting be reconciled against a
// vendor's session log). No other marker value (AI_AGENT=..., CODEX_CI=..., CLAUDECODE=...) is ever read into the
// payload. Never blocks or fails the commit: every error is swallowed, the fetch times out fast, the hook runs it in
// the background, and a hard timer ends the process regardless.
import { knownRuntimes, git, repoOf, patchId } from "./receipt-git.mjs";

/** Names of every known marker present in `env` (values are not read). */
export function markersPresent(env = process.env, table = knownRuntimes()) {
  const names = new Set();
  for (const rt of table.runtimes) for (const m of rt.markers) if (env[m] !== undefined && env[m] !== "") names.add(m);
  return [...names].sort();
}

/** -> { innermost: key|"unknown", session_id: string|null, markers: [names] } or null when no marker is present. */
export function innermostRuntime(env = process.env, table = knownRuntimes()) {
  const markers = markersPresent(env, table);
  if (!markers.length) return null;
  const present = (v) => v && env[v] !== undefined && env[v] !== "";
  const byKey = Object.fromEntries(table.runtimes.map((r) => [r.key, r]));
  const order = [...(table.innermost_priority || []), ...table.runtimes.map((r) => r.key)];
  for (const k of order) {
    const rt = byKey[k];
    if (rt && (rt.identity_vars || []).some(present)) return { innermost: rt.key, session_id: present(rt.session_var) ? String(env[rt.session_var]) : null, markers };
  }
  return { innermost: "unknown", session_id: null, markers };
}

/** Build the POST body for HEAD of the repo at `cwd`, or null (no markers, no remote). */
export function buildSighting(cwd, env = process.env) {
  const who = innermostRuntime(env);
  if (!who) return null;
  const repo = repoOf(cwd);
  if (!repo) return null;
  const line = git(cwd, ["log", "-1", "--format=%H %P", "HEAD"]).trim().split(/\s+/);
  const sha = line[0], parents = line.slice(1);
  return { repo, sha, patch_id: patchId(cwd, sha, parents), innermost: who.innermost, session_id: who.session_id, markers: who.markers };
}

/** Post it. Resolves to { sent, status?, why? }; never throws. */
export async function sendSighting({ cwd = process.cwd(), env = process.env, base, tokenFor, timeoutMs = 3000 } = {}) {
  try {
    if (env.AGENTCHAN_NO_SIGHTING) return { sent: false, why: "disabled" };
    const body = buildSighting(cwd, env);
    if (!body) return { sent: false, why: "no markers or no remote" };
    const table = knownRuntimes();
    const keys = [body.innermost, ...(table.innermost_priority || [])].filter((k, i, a) => k && k !== "unknown" && a.indexOf(k) === i);
    let token = null;
    for (const k of keys) { token = tokenFor(k); if (token) break; }
    if (!token) return { sent: false, why: "no token" };
    const r = await fetch(String(base).replace(/\/mcp$/, "").replace(/\/$/, "") + "/sightings", {
      method: "POST", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    return { sent: true, status: r.status };
  } catch (e) { return { sent: false, why: e.message }; }
}
