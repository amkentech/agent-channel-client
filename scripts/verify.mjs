// Receiving-side deterministic verification of a returned proposal, run in YOUR local clone
// (credentials stay on the machine that has them). Produces facts, then posts them via post_checks.
//
// Usage: node scripts/verify.mjs <proposal_id> [--repo-dir <path>] [--no-post] [--run-tests] [--runtime <key>]
//
// The token comes from that runtime's own variable, per lib/adapters.mjs, else ~/.agentchan/tok.<runtime>.json.
// With no --runtime that is claude, so AGENTCHAN_TOKEN=ac_... verify.mjs <id> behaves exactly as before.
//
// Checks:
//   ref_exists       the returned commit/branch is fetchable in this clone
//   scope_respected  every file changed between merge-base(main) and the ref matches a declared scope glob
//   tests            `npm test` exits 0 (skipped with --no-tests or if no test script)
//   build            `npm run build` exits 0 if a build script exists (else skipped)
//   no_change_needed if outcome=no_change_needed, asserts the ref (if any) has no diff vs main

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenFor, tokenEnvFor } from "../lib/paths.mjs";

const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
// post_checks is attributed to the agent that made the call, so this deciding which identity it holds is not
// a detail: verifying a return as the wrong runtime signs someone else's name to the findings. It read
// AGENTCHAN_TOKEN directly, which on a machine wired for Claude Code is claude-code, always.
const runtime = opt("--runtime") || process.env.AGENTCHAN_RUNTIME || "claude";
const token = tokenFor(runtime);
// The positional id is whatever is not a flag AND not a flag's value -- "--runtime windsurf" must not make
// "windsurf" the proposal id, which is how `--repo-dir <path> <id>` still misreads its own argument.
const takesValue = new Set(["--repo-dir", "--runtime"]);
const proposalId = args.find((a, i) => !a.startsWith("--") && !takesValue.has(args[i - 1]));
const repoDir = opt("--repo-dir") || process.cwd();
const noPost = args.includes("--no-post"), runTests = args.includes("--run-tests");
if (!proposalId) { console.error("usage: verify.mjs <proposal_id> [--repo-dir p] [--no-post] [--run-tests] [--runtime <key>]"); process.exit(1); }
if (!token) { console.error("no token for '" + runtime + "': set " + tokenEnvFor(runtime) + ", or run  node scripts/setup.mjs wire --runtime " + runtime); process.exit(1); }

const client = new Client({ name: "agentchan-verify", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
const call = async (name, a = {}) => { const r = await client.callTool({ name, arguments: a }); const t = r.content?.[0]?.text ?? ""; if (r.isError) throw new Error(name + ": " + t); try { return JSON.parse(t); } catch { return t; } };

const inbox = await call("my_inbox");
const p = inbox.proposals_for_you.find((x) => x.id === proposalId);
if (!p) { console.error("Proposal not in your inbox (must be addressed to you and returned)."); process.exit(1); }
if (p.status !== "returned") { console.error("Proposal status is " + p.status + ", not returned."); process.exit(1); }
const ref = p.return_ref || {};
const scope = (p.counter?.scope || p.scope || []);
console.log("Verifying " + p.id + "\n  task: " + p.task + "\n  scope: " + JSON.stringify(scope) + "\n  return: " + JSON.stringify(ref));

const exec = (file, fileArgs, options = {}) => execFileSync(file, fileArgs, {
  cwd: options.cwd || repoDir,
  stdio: options.stdio || ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  timeout: options.timeout,
  env: options.env,
  shell: false,
}).trim();
const git = (gitArgs, options) => exec("git", gitArgs, options);
const validateReturnedRef = (value) => {
  if (typeof value !== "string" || !value || value.length > 256 || value.startsWith("-") || /[\0-\x20\x7f]/.test(value)) throw new Error("invalid returned ref");
  return value;
};
const resolveCommit = (value) => {
  const candidate = validateReturnedRef(value);
  const oid = git(["rev-parse", "--verify", "--end-of-options", candidate + "^{commit}"]);
  if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new Error("git did not resolve the ref to a commit object");
  return oid;
};
const childEnv = () => {
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "ComSpec", "COMSPEC", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA"];
  const env = { CI: "1" };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};
const checks = [];
const add = (name, pass, detail, examined) => { checks.push({ name, pass, detail, examined }); console.log((pass ? "  ok   " : "  FAIL ") + name + (detail ? " - " + detail : "")); };

// ref_exists
const returnedRef = ref.commit || ref.branch || null;
let target = null;
try { git(["fetch", "--all", "--quiet"]); } catch {}
if (!returnedRef) {
  add("ref_exists", ref.outcome === "no_change_needed", ref.outcome === "no_change_needed" ? "no ref, outcome=no_change_needed" : "no commit/branch/pr in return");
} else {
  let ok = false, detail = "";
  try { target = resolveCommit(returnedRef); ok = true; detail = returnedRef + " -> " + target; }
  catch {
    try { target = resolveCommit("origin/" + validateReturnedRef(returnedRef)); ok = true; detail = "origin/" + returnedRef + " -> " + target; }
    catch { target = null; detail = "not found or invalid: " + String(returnedRef).slice(0, 256); }
  }
  add("ref_exists", ok, detail, "local git object database after fetching all remotes");
}

// scope_respected
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
if (target && checks[0].pass) {
  try {
    let base;
    try { base = git(["merge-base", target, "origin/main"]); }
    catch { base = git(["merge-base", target, "main"]); }
    const files = git(["diff", "--name-only", base, target, "--"]).split("\n").filter(Boolean);
    const res = scope.map(globToRe);
    const outside = files.filter((f) => !res.some((r) => r.test(f)) && !scope.includes(f));
    add("scope_respected", outside.length === 0, files.length + " file(s) changed" + (outside.length ? "; outside scope: " + outside.join(", ") : ""), files.length + " changed file path(s) vs " + scope.length + " declared scope glob(s); paths only, not contents");
    if (ref.outcome === "no_change_needed") add("no_change_needed", files.length === 0, files.length ? "claims no change but " + files.length + " file(s) differ" : "no diff");
  } catch (e) { add("scope_respected", false, "could not diff: " + e.message.split("\n")[0]); }
}

// tests / build (against the ref, in a temporary worktree so the working copy is untouched)
if (target && checks[0].pass && runTests) {
  const wt = join(repoDir, ".agentchan-verify-wt");
  try {
    try { git(["worktree", "remove", "--force", wt]); } catch {}
    git(["worktree", "add", "--detach", wt, target]);
    const pkgPath = join(wt, "package.json");
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const run = (name, commandArgs) => {
      const description = npm + " " + commandArgs.join(" ");
      try { exec(npm, commandArgs, { cwd: wt, stdio: "pipe", timeout: 300_000, env: childEnv() }); add(name, true, undefined, description + " at the returned ref in a clean worktree with a scrubbed environment"); }
      catch (e) { add(name, false, (e.stdout || e.stderr || e.message).toString().slice(-300), description + " at the returned ref in a clean worktree with a scrubbed environment"); }
    };
    if (pkg.scripts?.test) { if (existsSync(join(wt, "package-lock.json"))) run("install", ["ci", "--silent", "--ignore-scripts"]); run("tests", ["test", "--silent"]); } else add("tests", true, "skipped: no test script");
    if (pkg.scripts?.build) run("build", ["run", "build", "--silent"]);
  } finally { try { git(["worktree", "remove", "--force", wt]); } catch {} }
}

const allPass = checks.every((c) => c.pass);
console.log(allPass ? "ALL CHECKS PASS" : "CHECKS FAILED");
// Passing over what these checks cover must not read as passing over what they don't.
const notChecked = [runTests ? "runtime behavior beyond explicitly requested test/build scripts" : "runtime behavior (returned code was not executed; pass --run-tests to opt in)", "code quality or correctness of the diff contents", "files and state outside the returned ref's diff"];
if (!noPost) { const r = await call("post_checks", { proposal_id: p.id, checks, not_checked: notChecked }); console.log("posted:", JSON.stringify(r)); }
await client.close();
process.exit(allPass ? 0 : 3);
