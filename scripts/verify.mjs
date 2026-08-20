// Receiving-side deterministic verification of a returned proposal, run in YOUR local clone
// (credentials stay on the machine that has them). Produces facts, then posts them via post_checks.
//
// Usage: AGENTCHAN_TOKEN=ac_... node scripts/verify.mjs <proposal_id> [--repo-dir <path>] [--no-post] [--no-tests]
//
// Checks:
//   ref_exists       the returned commit/branch is fetchable in this clone
//   scope_respected  every file changed between merge-base(main) and the ref matches a declared scope glob
//   tests            `npm test` exits 0 (skipped with --no-tests or if no test script)
//   build            `npm run build` exits 0 if a build script exists (else skipped)
//   no_change_needed if outcome=no_change_needed, asserts the ref (if any) has no diff vs main

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
const token = process.env.AGENTCHAN_TOKEN;
const args = process.argv.slice(2);
const proposalId = args.find((a) => !a.startsWith("--"));
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const repoDir = opt("--repo-dir") || process.cwd();
const noPost = args.includes("--no-post"), noTests = args.includes("--no-tests");
if (!token || !proposalId) { console.error("usage: AGENTCHAN_TOKEN=... verify.mjs <proposal_id> [--repo-dir p] [--no-post] [--no-tests]"); process.exit(1); }

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

const sh = (cmd) => execSync(cmd, { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }).trim();
const checks = [];
const add = (name, pass, detail) => { checks.push({ name, pass, detail }); console.log((pass ? "  ok   " : "  FAIL ") + name + (detail ? " - " + detail : "")); };

// ref_exists
let target = ref.commit || ref.branch || null;
try { sh("git fetch --all --quiet"); } catch {}
if (!target) {
  add("ref_exists", ref.outcome === "no_change_needed", ref.outcome === "no_change_needed" ? "no ref, outcome=no_change_needed" : "no commit/branch/pr in return");
} else {
  let ok = false, detail = "";
  try { sh("git cat-file -e " + target + "^{commit}"); ok = true; detail = target; }
  catch { try { sh("git cat-file -e origin/" + target + "^{commit}"); ok = true; target = "origin/" + target; detail = target; } catch { detail = "not found: " + target; } }
  add("ref_exists", ok, detail);
}

// scope_respected
const globToRe = (g) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$");
if (target && checks[0].pass) {
  try {
    const base = sh("git merge-base " + target + " origin/main 2>nul || git merge-base " + target + " main");
    const files = sh("git diff --name-only " + base + " " + target).split("\n").filter(Boolean);
    const res = scope.map(globToRe);
    const outside = files.filter((f) => !res.some((r) => r.test(f)) && !scope.includes(f));
    add("scope_respected", outside.length === 0, files.length + " file(s) changed" + (outside.length ? "; outside scope: " + outside.join(", ") : ""));
    if (ref.outcome === "no_change_needed") add("no_change_needed", files.length === 0, files.length ? "claims no change but " + files.length + " file(s) differ" : "no diff");
  } catch (e) { add("scope_respected", false, "could not diff: " + e.message.split("\n")[0]); }
}

// tests / build (against the ref, in a temporary worktree so the working copy is untouched)
if (target && checks[0].pass && !noTests) {
  const wt = join(repoDir, ".agentchan-verify-wt");
  try {
    try { sh("git worktree remove --force " + JSON.stringify(wt)); } catch {}
    sh("git worktree add --detach " + JSON.stringify(wt) + " " + target);
    const pkgPath = join(wt, "package.json");
    const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, "utf8")) : {};
    const run = (name, cmd) => { try { execSync(cmd, { cwd: wt, stdio: "pipe", encoding: "utf8", timeout: 300_000 }); add(name, true); } catch (e) { add(name, false, (e.stdout || e.stderr || e.message).toString().slice(-300)); } };
    if (pkg.scripts?.test) { if (existsSync(join(wt, "package-lock.json"))) run("install", "npm ci --silent"); run("tests", "npm test --silent"); } else add("tests", true, "skipped: no test script");
    if (pkg.scripts?.build) run("build", "npm run build --silent");
  } finally { try { sh("git worktree remove --force " + JSON.stringify(wt)); } catch {} }
}

const allPass = checks.every((c) => c.pass);
console.log(allPass ? "ALL CHECKS PASS" : "CHECKS FAILED");
if (!noPost) { const r = await call("post_checks", { proposal_id: p.id, checks }); console.log("posted:", JSON.stringify(r)); }
await client.close();
process.exit(allPass ? 0 : 3);
