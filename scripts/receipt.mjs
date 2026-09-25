#!/usr/bin/env node
// agent-channel receipt <subcommand>   authorization receipts for agent-authored commits (docs/RECEIPTS.md)
//
//   check <base>..<head> [--json] [--strict --protected <glob,...>] [--public-key <pem>] [--server <url>]
//         [--allow-offline] [--repo host/owner/name] [--pr-body <text>] [--runtime <key>] [--report-only]
//         exit 0 = pass, 1 = fail, 2 = usage/error; --report-only prints the same result and exits 0 on a fail
//   mint (--contract <id> | --grant <id>) <base>..<head> [--repo ..] [--runtime <key>]   -> prints the Agent-Receipt trailer
//   declare <base>..<head> --attestation "<the human's own words>" [--repo ..] [--runtime <key>]  -> Human-Authored trailer
//   install-hook [repo path] [--uninstall]      post-commit sighting hook for ONE repo; chains any existing hook
//   sighting                                    (run by the hook) record agent markers for HEAD; silent, never fails
//
// Token (sightings, mint, declare): the runtime's own variable per lib/adapters.mjs, else ~/.agentchan/tok.<runtime>.json,
// the same resolution scripts/cli.mjs uses. --runtime defaults to AGENTCHAN_RUNTIME, else claude.
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenFor, tokenEnvFor, BASE } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const sub = argv[0];
const FLAGS_WITH_VALUE = new Set(["--protected", "--public-key", "--pubkey", "--server", "--repo", "--pr-body", "--runtime", "--contract", "--grant", "--attestation", "--timeout-ms"]);
const opt = {}, pos = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS_WITH_VALUE.has(a)) { if (i + 1 >= argv.length) usage("missing value for " + a); opt[a] = argv[++i]; }
  else if (a.startsWith("--")) opt[a] = true;
  else pos.push(a);
}
const runtime = opt["--runtime"] || process.env.AGENTCHAN_RUNTIME || "claude";
const server = String(opt["--server"] || BASE).replace(/\/mcp\/?$/, "").replace(/\/$/, "");

function usage(msg) {
  if (msg) console.error("error: " + msg);
  console.error(`usage: agent-channel receipt <subcommand>
  check <base>..<head> [--json] [--strict --protected <glob,...>] [--public-key <pem>] [--server <url>] [--allow-offline] [--repo host/owner/name] [--pr-body <text>] [--runtime <key>] [--report-only]
  mint (--contract <id> | --grant <id>) <base>..<head> [--repo host/owner/name] [--runtime <key>]
  declare <base>..<head> --attestation "<the human's own words>" [--repo host/owner/name] [--runtime <key>]
  install-hook [repo path] [--uninstall]
  sighting`);
  process.exit(2);
}

async function mcpCall(tool, args) {
  const token = tokenFor(runtime);
  if (!token) { console.error("no token for '" + runtime + "': set " + tokenEnvFor(runtime) + ", or run  agent-channel wire --runtime " + runtime); process.exit(2); }
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "agentchan-receipt", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    const text = r.content?.[0]?.text ?? JSON.stringify(r);
    let parsed = null; try { parsed = JSON.parse(text); } catch {}
    return { isError: !!r.isError, text, parsed };
  } finally { await client.close().catch(() => {}); }
}

async function rangeCommits(range) {
  const { parseRange, commitsInRange, commitInfo, repoOf } = await import("../lib/receipt-git.mjs");
  if (!parseRange(range)) usage("expected a commit range <base>..<head>, got " + JSON.stringify(range ?? ""));
  const cwd = process.cwd();
  const repo = repoOf(cwd, opt["--repo"]);
  if (!repo) { console.error("error: cannot name this repo: no origin remote in host/owner/name form. Pass --repo host/owner/name."); process.exit(2); }
  let commits;
  try { commits = commitsInRange(cwd, range).map((s) => commitInfo(cwd, s)); }
  catch (e) { console.error("error: git could not read " + range + ": " + (e.stderr || e.message).toString().trim()); process.exit(2); }
  if (!commits.length) { console.error("error: " + range + " contains no commits"); process.exit(2); }
  return { repo, commits };
}

if (sub === "check") {
  const { parseRange } = await import("../lib/receipt-git.mjs");
  const range = pos[0];
  if (!parseRange(range)) usage("expected a commit range <base>..<head>, got " + JSON.stringify(range ?? ""));
  if (opt["--strict"] && !opt["--protected"]) usage("--strict needs --protected <glob,...>");
  if (opt["--protected"] && !opt["--strict"]) usage("--protected only applies with --strict");
  const { checkRange, formatHuman } = await import("../lib/receipt-check.mjs");
  let res;
  try {
    res = await checkRange({
      cwd: process.cwd(), range, server, publicKeyFile: opt["--public-key"] || opt["--pubkey"] || null,
      token: tokenFor(runtime), allowOffline: !!opt["--allow-offline"], strict: !!opt["--strict"],
      protectedGlobs: opt["--protected"] ? String(opt["--protected"]).split(",").map((s) => s.trim()) : [],
      repo: opt["--repo"] || null, prBody: typeof opt["--pr-body"] === "string" ? opt["--pr-body"] : null,
      timeoutMs: opt["--timeout-ms"] ? Number(opt["--timeout-ms"]) : undefined,
    });
  } catch (e) {
    const msg = (e.stderr ? String(e.stderr).trim() : "") || e.message;
    if (opt["--json"]) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error("error: " + msg);
    process.exit(2);
  }
  console.log(opt["--json"] ? JSON.stringify(res, null, 2) : formatHuman(res));
  // --report-only: the full result above, then exit 0 whatever the verdict. For adopting the check on a repo whose
  // history predates receipts. It relaxes the verdict only: usage and git/runtime errors above still exit 2.
  // --json output is left byte-identical (parse `ok` yourself); the human form gets one closing line.
  if (opt["--report-only"]) {
    if (!opt["--json"]) console.log("REPORT-ONLY: verdict " + (res.ok ? "PASS" : "FAIL") + " is reported, not enforced (exit 0).");
    process.exit(0);
  }
  process.exit(res.ok ? 0 : 1);
}

else if (sub === "mint") {
  const c = opt["--contract"], g = opt["--grant"];
  if (!!c === !!g || typeof (c || g) !== "string") usage("mint needs exactly one of --contract <id> or --grant <id>");
  const { repo, commits } = await rangeCommits(pos[0]);
  const args = { ...(c ? { contract_id: c } : { grant_id: g }), repo, commits: commits.map((x) => ({ sha: x.sha, patch_id: x.patch_id, paths: x.paths })) };
  const r = await mcpCall("mint_receipt", args);
  if (r.isError || !r.parsed?.receipt_id) { console.error("mint_receipt refused: " + r.text); process.exit(1); }
  const trailer = r.parsed.trailer || ("Agent-Receipt: " + r.parsed.receipt_id + " " + r.parsed.root);
  console.log(trailer);
  console.error("receipt " + r.parsed.receipt_id + " covers " + commits.length + " commit(s) in " + repo + (r.parsed.url ? "; document: " + r.parsed.url : "") + (r.parsed.status_url ? "; status: " + r.parsed.status_url : ""));
  console.error("add it to the commit or PR body, e.g.  git commit --amend --trailer \"" + trailer + "\"  (amending changes the sha; the receipt still matches by patch-id)");
}

else if (sub === "declare") {
  const words = opt["--attestation"];
  if (typeof words !== "string" || !words.trim()) usage("declare needs --attestation \"<the human's own words>\"");
  const { repo, commits } = await rangeCommits(pos[0]);
  const r = await mcpCall("declare_authorship", { repo, commits: commits.map((x) => ({ sha: x.sha, patch_id: x.patch_id })), attestation: words });
  if (r.isError || !r.parsed?.declaration_id) { console.error("declare_authorship refused: " + r.text); process.exit(1); }
  console.log(r.parsed.trailer || ("Human-Authored: " + r.parsed.declaration_id));
  console.error("declaration " + r.parsed.declaration_id + " covers " + commits.length + " commit(s) in " + repo);
}

else if (sub === "install-hook") {
  const { installHook, uninstallHook } = await import("../lib/receipt-hook.mjs");
  const repoPath = resolve(pos[0] || ".");
  try {
    if (opt["--uninstall"]) { const r = uninstallHook(repoPath); console.log(r.action + ": " + r.hook); }
    else {
      const r = installHook(repoPath, { entry: join(HERE, "..", "bin", "agent-channel.mjs") });
      console.log(r.action + ": " + r.hook);
      for (const n of r.notes) console.log(n);
    }
  } catch (e) { console.error("error: " + ((e.stderr ? String(e.stderr).trim() : "") || e.message)); process.exit(2); }
}

else if (sub === "sighting") {
  // Never fails, never blocks: a hard stop regardless of what the network does.
  setTimeout(() => process.exit(0), 5000);
  try {
    const { sendSighting } = await import("../lib/receipt-sighting.mjs");
    const r = await sendSighting({ cwd: process.cwd(), base: server, tokenFor });
    if (process.env.AGENTCHAN_SIGHTING_DEBUG) console.error(JSON.stringify(r));
  } catch {}
  process.exit(0);
}

else usage(sub ? "unknown subcommand " + sub : null);
