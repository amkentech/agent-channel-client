// `agent-channel receipt install-hook [repo] [--uninstall]`: a post-commit hook in ONE repo's .git/hooks that runs
// `agent-channel receipt sighting` in the background.
//
// Rules: never overwrite someone's hook (an existing post-commit is moved aside to post-commit.agent-channel-chained
// and run first, its exit status preserved); idempotent (re-installing rewrites only our own file); uninstall puts the
// original back. Never touches core.hooksPath at any level; if core.hooksPath is set, git will not run hooks from
// .git/hooks and install says so loudly instead of redirecting anything.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, chmodSync, mkdirSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { git } from "./receipt-git.mjs";

export const HOOK_MARK = "# agent-channel receipt sighting hook (managed)";
export const CHAINED = "post-commit.agent-channel-chained";
const fwd = (p) => String(p).replace(/\\/g, "/");
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function hookScript({ node = process.execPath, entry }) {
  return `#!/bin/sh
${HOOK_MARK}
# Written by: agent-channel receipt install-hook. Remove with: agent-channel receipt install-hook --uninstall
# Runs any pre-existing post-commit hook first (moved to ${CHAINED}), then records a sighting in the background.
# The sighting reads env marker NAMES only, sends nothing when no agent marker is present, and can never fail the commit.
hookdir=$(dirname "$0")
rc=0
if [ -f "$hookdir/${CHAINED}" ]; then
  "$hookdir/${CHAINED}" "$@"
  rc=$?
fi
if [ -z "$AGENTCHAN_NO_SIGHTING" ]; then
  node=${shq(fwd(node))}
  entry=${shq(fwd(entry))}
  if [ -f "$entry" ]; then
    ( "$node" "$entry" receipt sighting </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1
  elif command -v agent-channel >/dev/null 2>&1; then
    ( agent-channel receipt sighting </dev/null >/dev/null 2>&1 & ) >/dev/null 2>&1
  fi
fi
exit $rc
`;
}

/** The repo's hooks dir (.git/hooks of the common dir, so worktrees share it) and any core.hooksPath in effect. */
export function hooksDir(repoPath) {
  const top = resolve(repoPath || ".");
  let common = git(top, ["rev-parse", "--git-common-dir"]).trim();
  if (!isAbsolute(common)) common = resolve(top, common);
  let hooksPath = null;
  try { hooksPath = git(top, ["config", "--get", "core.hooksPath"]).trim() || null; } catch {}
  return { dir: join(common, "hooks"), hooksPath };
}

export function installHook(repoPath, { entry, node = process.execPath } = {}) {
  const { dir, hooksPath } = hooksDir(repoPath);
  mkdirSync(dir, { recursive: true });
  const hook = join(dir, "post-commit"), chained = join(dir, CHAINED);
  const notes = [];
  let action = "installed";
  if (existsSync(hook)) {
    const cur = readFileSync(hook, "utf8");
    if (cur.includes(HOOK_MARK)) action = "refreshed (already installed)";
    else {
      if (existsSync(chained)) throw new Error("both a foreign post-commit and " + CHAINED + " exist in " + dir + "; refusing to guess which is the original. Resolve by hand.");
      renameSync(hook, chained);
      action = "installed, chaining the existing post-commit (moved to " + CHAINED + ")";
    }
  }
  const script = hookScript({ node, entry });
  const changed = !existsSync(hook) || readFileSync(hook, "utf8") !== script;
  if (changed) writeFileSync(hook, script);
  try { chmodSync(hook, 0o755); } catch {}
  if (hooksPath) notes.push("WARNING: core.hooksPath is set (" + hooksPath + "), so git does NOT run hooks from " + dir + ". The hook was written but is inactive. This command never changes core.hooksPath; wire it into that directory yourself if you want it.");
  return { hook, action, changed, notes };
}

export function uninstallHook(repoPath) {
  const { dir } = hooksDir(repoPath);
  const hook = join(dir, "post-commit"), chained = join(dir, CHAINED);
  if (!existsSync(hook) || !readFileSync(hook, "utf8").includes(HOOK_MARK)) {
    return { hook, action: existsSync(hook) ? "left alone: the post-commit hook there is not ours" : "nothing to remove" };
  }
  unlinkSync(hook);
  if (existsSync(chained)) { renameSync(chained, hook); return { hook, action: "removed; the original post-commit hook is restored" }; }
  return { hook, action: "removed" };
}
