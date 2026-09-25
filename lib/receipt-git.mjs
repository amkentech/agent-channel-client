// The git side of receipts: commits in a range, their trailers, their ACTUAL changed paths, their stable patch-ids,
// and the repo name in the wire contract's normal form (host/owner/name, lowercased, from the git remote).
//
// Everything here reads git plumbing (rev-list, diff-tree, patch-id), which ignores UI config such as diff.renames or
// diff.noprefix, so the check computes the same paths and patch-ids as `receipt mint` did on another machine.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIMES_FILE = join(dirname(fileURLToPath(import.meta.url)), "agent-runtimes.json");
let runtimesCache = null;
/** The known-runtime table (lib/agent-runtimes.json). */
export function knownRuntimes() {
  if (!runtimesCache) runtimesCache = JSON.parse(readFileSync(RUNTIMES_FILE, "utf8"));
  return runtimesCache;
}

export function git(cwd, args, opts = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024, windowsHide: true, ...opts });
}

/**
 * Canonical repo name: lowercase slash-joined segments, host first when there is one. Accepts https/ssh/scp remotes,
 * user@ and user:password@, ports, a trailing .git, and a bare "host/owner/name" or host-less "owner/name" (a scope
 * entry). Host aliases fold to one name so every remote form of a repo binds the same:
 *   ssh.github.com (SSH over 443)                       -> github.com
 *   git@ssh.dev.azure.com:v3/org/proj/repo              -> dev.azure.com/org/proj/repo
 *   https://org@dev.azure.com/org/proj/_git/repo        -> dev.azure.com/org/proj/repo
 *   https://org.visualstudio.com[/DefaultCollection]/proj/_git/repo -> dev.azure.com/org/proj/repo
 *   Azure's .../org/_git/repo (project named like the repo) -> dev.azure.com/org/repo/repo
 * scp form has no port (git's rule): git@host:22/x/y is the path 22/x/y. Percent-escapes (%20 in Azure project
 * names) are kept, not decoded. Local paths and file:// return null.
 * KEEP IDENTICAL: src/receipts.js normRepo and lib/receipt-git.mjs normRepo are the same function, character for
 * character; test/receipt-repo-canon.test.mjs compares their source and a table of remotes through both.
 */
export function normRepo(input) {
  let s = String(input ?? "").trim();
  if (!s || s.length > 300 || /^file:/i.test(s)) return null;
  s = s.toLowerCase();
  let host = null, path = s, m;
  if ((m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^@/:]+)(?::\d+)?(?:\/(.*))?$/))) { host = m[1]; path = m[2] || ""; }
  else if ((m = s.match(/^(?:[^@/:]+@)?([^@/:]{2,}):(?!\/\/)(.*)$/))) { host = m[1]; path = m[2]; }
  let segs = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
  if (host === null && segs.length >= 3 && (segs[0].includes(".") || segs[0] === "localhost")) host = segs.shift();
  if (host === "ssh.github.com") host = "github.com";
  else if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    host = "dev.azure.com";
    if (segs[0] === "v3") segs = segs.slice(1);
  } else if (host === "dev.azure.com" || (host && host.endsWith(".visualstudio.com"))) {
    if (host !== "dev.azure.com") { segs = [host.slice(0, -".visualstudio.com".length), ...segs]; host = "dev.azure.com"; }
    if (segs[1] === "defaultcollection") segs.splice(1, 1);
    if (segs[1] === "_git" && segs.length === 3) segs = [segs[0], segs[2], segs[2]];
    else if (segs[2] === "_git") segs.splice(2, 1);
  }
  const all = host ? [host, ...segs] : segs;
  if (all.length < 2 || all.some((p) => !/^(?:[a-z0-9._~-]|%[0-9a-f]{2})+$/.test(p) || p === "." || p === "..")) return null;
  return all.join("/");
}

/** host/owner/name: the first segment is a host (has a dot, or is localhost). Same rule as src/receipts.js hasHost. */
export const hasHost = (r) => !!r && r.split("/").length >= 3 && (r.split("/")[0].includes(".") || r.split("/")[0] === "localhost");

/** Normalise a git remote URL to host/owner/name per the wire contract, or null when it names no host (a local path,
 *  file://, a bare owner/name, or a single-label host such as http://gitlab/group/repo, which the server refuses too). */
export function normalizeRepo(url) {
  const r = normRepo(url);
  return hasHost(r) ? r : null;
}

/** The repo this checkout pushes to, per the wire contract. `override` wins (already-normal or a URL). */
export function repoOf(cwd, override) {
  if (override) return normalizeRepo(override) || String(override).toLowerCase();
  try { return normalizeRepo(git(cwd, ["remote", "get-url", "origin"]).trim()); } catch { return null; }
}

/**
 * Parse trailer lines ("Key: value", continuation lines unfolded) into [{ key, value }].
 * For a commit, feed it git's own trailer block (%(trailers:only,unfold)); for a PR body, the whole text: only the
 * receipt trailers are read from PR bodies (see prBodyTrailers).
 */
export function parseTrailers(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    if (/^\s/.test(raw) && out.length && raw.trim()) { out.at(-1).value += " " + raw.trim(); continue; }
    const m = raw.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\s*:\s*(.*)$/);
    if (m) out.push({ key: m[1], value: m[2].trim() });
  }
  return out;
}

/** Classify trailers into the three the check reads. Keys are case-insensitive (git's rule). */
export function classifyTrailers(list) {
  const t = { receipts: [], declarations: [], coAuthors: [] };
  for (const { key, value } of list) {
    const k = key.toLowerCase();
    if (k === "agent-receipt") { const [id, root] = value.split(/\s+/); if (id) t.receipts.push({ id, root: root || null }); }
    else if (k === "human-authored") { const id = value.split(/\s+/)[0]; if (id) t.declarations.push({ id }); }
    else if (k === "co-authored-by") t.coAuthors.push(value);
  }
  return t;
}

/** Receipt trailers in a PR body, anywhere in the text (PR bodies have no trailer block). */
export function prBodyTrailers(text) {
  const list = parseTrailers(text).filter((x) => /^(agent-receipt|human-authored)$/i.test(x.key));
  return classifyTrailers(list);
}

/** Which known runtimes does this set of Co-Authored-By values name? -> [{ key, label, value }] */
export function coAuthorRuntimes(coAuthors, table = knownRuntimes()) {
  const hits = [];
  for (const v of coAuthors) for (const rt of table.runtimes) {
    if ((rt.co_authored_by || []).some((re) => new RegExp(re, "i").test(v))) { hits.push({ key: rt.key, label: rt.label, value: v }); break; }
  }
  return hits;
}

/** Commit shas in <base>..<head>, oldest first (merges included). */
export function commitsInRange(cwd, range) {
  const out = git(cwd, ["rev-list", "--reverse", range]).trim();
  return out ? out.split(/\r?\n/) : [];
}

/** Actual changed paths of a commit. Non-merge: vs its parent (root: vs empty). Merge: only what the merge itself
 *  changed relative to every parent (--cc), so an "evil merge" is still seen. --no-renames: a rename is a delete
 *  of the old path plus an add of the new one, and both must be in scope. */
export function changedPaths(cwd, sha, parents) {
  const args = parents.length > 1 ? ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--no-renames", "--cc", sha]
    : ["diff-tree", "-r", "-z", "--no-commit-id", "--name-only", "--no-renames", "--root", sha];
  return [...new Set(git(cwd, args).split("\0").filter(Boolean))];
}

/** `git patch-id --stable` of a non-merge commit, or null (merge, or empty diff). */
export function patchId(cwd, sha, parents) {
  if (parents.length > 1) return null;
  const diff = git(cwd, ["diff-tree", "-p", "--no-color", "--no-ext-diff", "--root", sha]);
  if (!diff.trim()) return null;
  const out = git(cwd, ["patch-id", "--stable"], { input: diff }).trim();
  return out ? out.split(/\s+/)[0] : null;
}

/** Full picture of one commit: sha, parents, subject, trailers (classified), paths, patch_id. */
export function commitInfo(cwd, sha) {
  const raw = git(cwd, ["log", "-1", "--format=%H%x00%P%x00%s%x00%(trailers:only,unfold)", sha]);
  const [full, parentsRaw, subject, trailerBlock] = raw.split("\0");
  const parents = parentsRaw.trim() ? parentsRaw.trim().split(/\s+/) : [];
  return {
    sha: full.trim(), parents, subject,
    trailers: classifyTrailers(parseTrailers(trailerBlock)),
    paths: changedPaths(cwd, full.trim(), parents),
    patch_id: patchId(cwd, full.trim(), parents),
  };
}

/** Parse "<base>..<head>" (the only form accepted; "..." symmetric ranges are refused as ambiguous). */
export function parseRange(r) {
  const s = String(r || "");
  if (!s || s.includes("...") || !/^[^.\s][^\s]*\.\.[^.\s][^\s]*$/.test(s)) return null;
  return s;
}
