#!/usr/bin/env node
// One-command onboarding and health check for a person joining Agent Channel.
//
//   node scripts/setup.mjs join <inv_code> <handle> "<Display Name>" [--runtime claude|codex|grok|all] [--email you@x.com]
//        -> creates your identity + one agent token per DETECTED runtime (Claude Code, Codex, Desktop, Cursor, Gemini,
//           Windsurf, Grok), connected to whoever invited you, then wires everything below
//   node scripts/setup.mjs signin <handle> [--runtime ...]
//        -> you already exist; a NEW MACHINE or runtime gets its own token via a code emailed to your verified address.
//           One identity, many runtimes: never a second handle.
//   node scripts/setup.mjs init
//        -> the one command: token on this machine? detect every agent CLI, register into each, verify. No token? it
//           says which of join/signin applies.
//   node scripts/setup.mjs wire [--runtime claude|codex|grok] [--token ac_...]
//        -> MCP server in the client, hooks (type-to-send, waiting banner, status), token storage, listener at logon, listener now
//   node scripts/setup.mjs doctor
//        -> checks every piece and says exactly what is missing
//
// Nothing here needs the admin key. Runtime-specific behavior lives in lib/adapters.mjs.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { ADAPTERS, adapterFor, mergeHooks, which } from "../lib/adapters.mjs";
import { readTok as readTokStore, saveTok as saveTokStore, tokFileHome, tokenEnvHint, refreshTokenEnv, CLIENT_HOME, IN_NPX_CACHE, HOME_STORE, RELOCATED } from "../lib/paths.mjs";
import { readDiag, summarizeDiag } from "../lib/diag.mjs";
import { summarizePushLog, configuredWs, wsHostPort, probe, probeLoadedThread, pushVerdict } from "../lib/codex-health.mjs";

let REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let DEPS_MISSING = false; // the listener's npm deps failed to install in CLIENT_HOME; step 7 must not write a startup entry that crash-loops
// Running from an npx cache (npx @amkentech/agent-channel join ...)? That folder can vanish, and hooks/listener need a stable path:
// copy this package to ~/.agentchan/client and run from there. A git checkout or a global install stays where it is.
if (IN_NPX_CACHE && !process.env.AGENTCHAN_NO_SELF_INSTALL) {
  const { cpSync } = await import("node:fs");
  cpSync(REPO, CLIENT_HOME, { recursive: true, force: true, filter: (src) => !/[\\/](\.git|\.tok\.[^\\/]+\.json|\.env[^\\/]*)$/.test(src) });
  // the listener needs the package's own deps (ws, MCP sdk); hooks need none. Install them once in the persistent copy.
  try { const { execFileSync: x } = await import("node:child_process"); x(platform() === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: CLIENT_HOME, stdio: "ignore", shell: platform() === "win32" }); }
  catch { DEPS_MISSING = true; console.log("  problem: listener dependencies failed to install. Hooks and messaging still work, but the listener (toasts, incoming files) won't start.\n  fix:  cd " + CLIENT_HOME + " && npm install --omit=dev --ignore-scripts"); }
  console.log("  installed client to " + CLIENT_HOME + " (hooks and the listener run from there; re-run join/wire from any npx to update)");
  REPO = CLIENT_HOME;
}
// The canonical server. lib/paths.mjs BASE applies the same default inline and exports no constant for it, so
// the literal lives here too; keep the two in step. doctor flags a BASE that differs from this.
const DEFAULT_BASE = "https://channel.amkentech.com";
const BASE = (process.env.AGENTCHAN_URL || DEFAULT_BASE).replace(/\/mcp$/, "");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const H = homedir();
const WIN = platform() === "win32";
// The scheduled task scripts/listener-watchdog.mjs registers (TASK there). A literal rather than an import:
// that script runs its command on import.
const WATCHDOG_TASK = "AgentChannelListenerWatchdog";

/** The per-user Startup folder on Windows. AGENTCHAN_STARTUP_DIR overrides it so a test can hand wire and
 *  doctor a temp folder; null where there is no such folder (macOS/Linux use LaunchAgent/systemd instead). */
function startupDir() {
  if (process.env.AGENTCHAN_STARTUP_DIR) return process.env.AGENTCHAN_STARTUP_DIR;
  if (!WIN) return null;
  return join(process.env.APPDATA || join(H, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}
const canonicalVbs = (key) => "agent-channel-" + key + ".vbs";
const listenerKeys = () => Object.values(ADAPTERS).filter((a) => a.listener).map((a) => a.key);

/** Every .vbs in the Startup folder that launches a listener, with the listener keys it references.
 *  Read-only; returns [] when the folder is missing or unreadable. */
function startupListenerEntries(startup) {
  const out = [];
  if (!startup) return out;
  let names = []; try { names = readdirSync(startup); } catch { return out; }
  for (const name of names) {
    if (!/\.vbs$/i.test(name)) continue;
    let text = ""; try { text = readFileSync(join(startup, name), "utf8"); } catch { continue; }
    if (!text.includes("run_listen_")) continue;
    const keys = listenerKeys().filter((k) => text.includes("run_listen_" + k + ".cmd"));
    out.push({ name, file: join(startup, name), text, keys, canonical: listenerKeys().some((k) => name.toLowerCase() === canonicalVbs(k)) });
  }
  return out;
}

/** The hand-written AgentChannelListeners.vbs (byte-identical to the repo's start_listeners.vbs) launched every
 *  listener at logon. Once wire writes the per-runtime agent-channel-<key>.vbs next to it, each listener starts
 *  TWICE, and the watchdog then refuses to act because it cannot attribute the second process. This plans the
 *  cleanup for `keys` -- the runtimes whose canonical entry exists (or is about to). Only a non-canonical .vbs
 *  that references run_listen_ is ever touched, and only its run_listen_<key>.cmd lines go: a legacy file that
 *  also launches something else (this machine's launches run_codex_appserver.cmd) is rewritten without the
 *  listener lines rather than deleted, so nothing that is not a duplicate stops starting at logon. */
function planLegacyStartupCleanup(startup, keys) {
  const plan = [];
  for (const e of startupListenerEntries(startup)) {
    if (e.canonical) continue;
    const dropped = e.keys.filter((k) => keys.includes(k));
    if (!dropped.length) continue;
    const isDup = (line) => dropped.some((k) => line.includes("run_listen_" + k + ".cmd"));
    const kept = e.text.split(/\r?\n/).filter((line) => !isDup(line));
    const launchesLeft = kept.some((line) => /\.Run\b/i.test(line));
    plan.push({ ...e, dropped, action: launchesLeft ? "rewrite" : "delete", text: launchesLeft ? kept.join("\r\n") : "" });
  }
  return plan;
}
async function applyLegacyStartupCleanup(plan) {
  const { rmSync } = await import("node:fs");
  for (const p of plan) {
    try {
      if (p.action === "delete") { rmSync(p.file); ok("removed duplicate startup entry " + p.file + " (it started " + p.dropped.join(", ") + " a second time at logon)"); }
      else { writeFileSync(p.file, p.text); ok("dropped the " + p.dropped.map((k) => "run_listen_" + k + ".cmd").join(", ") + " line(s) from " + p.file + " (a second logon start); its other launch lines are kept"); }
    } catch (e) { warn("could not clean the duplicate startup entry " + p.file + ": " + e.message); }
  }
}

/** Does this adapter's own hooksWire include the named hook script? doctor asks the adapter rather than keying on
 *  a runtime name, so a runtime that gains a seam is reported the day its adapter gains it. Returns false rather
 *  than throwing: doctor's job is to report, never to become the thing that fails. */
const wiresHook = (ad, name) => {
  try { return JSON.stringify(ad.hooksWire({ repo: REPO }).hooks || {}).includes("hooks/" + name); }
  catch { return false; }
};
const say = (s) => console.log(s);
const ok = (s) => say("  ok   " + s);
const bad = (s) => say("  MISSING  " + s);
const warn = (s) => say("  note " + s);

const tokFile = (key) => tokFileHome(key);            // tokens live in ~/.agentchan, not next to the code
const readTok = (key) => readTokStore(key);
const saveTok = (key, obj) => saveTokStore(key, obj);

/** Every credential this runtime might legitimately be, in precedence order, each carrying WHERE it came from
 *  and what handle that source claims.
 *
 *  This used to be a single expression: env var, else file. Only the first answer was ever consulted, which is
 *  what made the mint loop. The `generic` adapter shared AGENTCHAN_TOKEN with Claude Code, so on a machine
 *  wired for Claude Code `wire --runtime <unknown>` read Claude Code's token, correctly detected the mismatch,
 *  minted an "other" agent, saved it to the file -- and the next run read the environment again and never
 *  looked at the file it had just written. Four runs and the per-runtime cap of 4 is spent; after that wire is
 *  a silent no-op. A LIST, tried in order, is what makes that terminate: once the file holds a correct token,
 *  the wrong env var loses to it instead of triggering another mint. */
function tokenCandidates(ad, explicit) {
  const out = [];
  const add = (token, from, handle) => {
    if (token && !out.some((c) => c.token === token)) out.push({ token, from, handle: handle ? String(handle).replace(/^@/, "") : null });
  };
  add(explicit, "--token", null);
  add(process.env[ad.tokenEnv], "the environment (" + ad.tokenEnv + ")", null);
  const rec = readTok(ad.key);
  add(rec?.token, rec?.file || tokFile(ad.key), rec?.handle);
  // Claude Desktop predates having a join of its own; Claude Code's token was its documented fallback. It is
  // still tried, but only as a CANDIDATE now: against a reachable server it is always a runtime mismatch, so
  // what it really buys is a seed to mint Desktop its own agent with.
  if (ad.key === "claude-desktop") { const c = readTok("claude"); add(c?.token, c?.file || tokFile("claude"), c?.handle); }
  return out;
}
const tokenFor = (ad) => tokenCandidates(ad)[0]?.token || null;   // best guess, for doctor's read-only report

async function api(path, body, token, retry = 1) {
  try { return await api1(path, body, token); }
  catch (e) { if (retry > 0 && /fetch failed/i.test(e.message)) return api(path, body, token, retry - 1); throw e; } // keep-alive socket reset after a long sync exec
}
async function api1(path, body, token) {
  const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (j.error || ""));
  return j;
}

function runtimesWanted() {
  const r = (opt("--runtime", "") || "").toLowerCase();
  if (r === "both") return [ADAPTERS.claude, ADAPTERS.codex];
  if (r === "all") return Object.values(ADAPTERS).filter((a) => a.key !== "generic" && a.detect());
  if (r === "desktop" || r === "claude-desktop") return [ADAPTERS["claude-desktop"]];
  if (r) return [adapterFor(r)];
  // Default = every client detected on this machine. The person is one identity; the sender never needs to know which
  // CLI they sit in, so setup should land in all of them, not make the human enumerate.
  const found = Object.values(ADAPTERS).filter((a) => a.key !== "generic" && a.detect());
  return found.length ? found : [ADAPTERS.claude];
}

// ---------------- join ----------------
async function join_() {
  const [code, handle, display_name] = args.slice(1).filter((x, i, arr) => !x.startsWith("--") && arr[i - 1] !== "--runtime" && arr[i - 1] !== "--email");
  if (!code || !handle || !display_name) { say('usage: npx @amkentech/agent-channel join <inv_code> <handle> "<Display Name>" [--runtime claude|codex|grok|all] [--email you@x.com]   (default: every detected client)'); process.exit(1); }
  const ads = runtimesWanted();
  const first = ads[0];
  say("Joining Agent Channel as @" + handle.replace(/^@/, "") + " (" + ads.map((a) => a.label).join(" + ") + ")...");
  const j = await api("/join", { code, handle, display_name, runtime: first.runtime, email: opt("--email"), agent_name: first.key });
  saveTok(first.key, { handle: j.handle.replace(/^@/, ""), agent_id: j.agent.id, runtime: first.runtime, token: j.token, base: BASE });
  say("Welcome, " + j.handle + ". Connected to " + j.connected_to + ". Token for " + first.label + " saved to " + tokFile(first.key) + " (gitignored; shown nowhere else).");
  for (const ad of ads.slice(1)) {
    const a2 = await api("/agents", { name: ad.key, runtime: ad.runtime }, j.token);
    saveTok(ad.key, { handle: j.handle.replace(/^@/, ""), agent_id: a2.id, runtime: ad.runtime, token: a2.token, base: BASE });
    say("Second agent for " + ad.label + " minted and saved to " + tokFile(ad.key) + ".");
  }
  if (!args.includes("--no-wire")) for (const ad of ads) await wire(ad);
  say("");
  say("Done. Last step, so you can see it working:");
  for (const ad of ads) {
    const cw = ad.commandsWire ? ad.commandsWire({ repo: REPO }) : null;
    if (cw) {
      say(ad.label + ":");
      say("  1. close this terminal and open a new one (the token needs a fresh shell)");
      say("  2. start " + ad.label);
      say("  3. type " + cw.invokeAs("inbox.md") + " — your inbox appearing means everything is wired");
    } else {
      say(ad.label + ": open it and type:   @" + j.connected_to.replace(/^@/, "") + " hi, I'm in.");
    }
  }
  say("Then run  npx @amkentech/agent-channel doctor  any time.");
}

// ---------------- signin: this person already exists; a new machine or runtime gets its own token ----------------
// The server side is /signin/start + /signin/finish (src/oauth.js): handle -> 6-digit code to the VERIFIED email ->
// agent token, the same hardened flow as the OAuth consent page. This is the path that prevents the second-handle
// mistake: an existing identity extends to a new machine instead of joining again as someone else.
async function signin_() {
  const positional = args.slice(1).filter((x, i, arr) => !x.startsWith("--") && arr[i - 1] !== "--runtime" && arr[i - 1] !== "--token");
  const handle = (positional[0] || "").replace(/^@/, "").toLowerCase();
  if (!handle) { say("usage: npx @amkentech/agent-channel signin <handle> [--runtime claude|codex|grok|all]   (a code goes to the email you verified with verify_email)"); process.exit(1); }
  const ads = runtimesWanted();
  const first = ads[0];
  const { randomBytes } = await import("node:crypto");
  const clientLabel = ("The Agent Channel CLI on " + (await import("node:os")).hostname()).slice(0, 80);
  const nonce = randomBytes(24).toString("base64url");
  say("Signing in as @" + handle + " (" + ads.map((a) => a.label).join(" + ") + ")...");
  let st = await api("/signin/start", { handle, nonce, client: clientLabel, runtime: first.runtime });
  say("  " + st.message);
  const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
  let fin = null;
  for (;;) {
    const a = (await rl.question("  Code from the email (or r = send a new one): ")).trim();
    if (!a) continue;
    if (/^r$/i.test(a)) { st = await api("/signin/start", { handle, nonce, client: clientLabel, runtime: first.runtime, resend: true }); say("  " + st.message); continue; }
    const r = await fetch(BASE + "/signin/finish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle, nonce, ticket: st.ticket, code: a, runtime: first.runtime, agent_name: first.key, client: clientLabel }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) { fin = j; break; }
    say("  " + (j.error || "error " + r.status));
    if (j.reset) { rl.close(); say("Start over:  npx @amkentech/agent-channel signin " + handle); process.exit(1); }
  }
  rl.close();
  saveTok(first.key, { handle: fin.handle.replace(/^@/, ""), agent_id: fin.agent_id, runtime: first.runtime, token: fin.token, base: BASE });
  say("Welcome back, @" + fin.handle.replace(/^@/, "") + ". Token for " + first.label + " saved to " + tokFile(first.key) + " (shown nowhere else).");
  for (const ad of ads.slice(1)) {
    if (readTok(ad.key)?.token) { say(ad.label + " already has a token on this machine; keeping it."); continue; }
    const a2 = await api("/agents", { name: ad.key, runtime: ad.runtime }, fin.token);
    saveTok(ad.key, { handle: fin.handle.replace(/^@/, ""), agent_id: a2.id, runtime: ad.runtime, token: a2.token, base: BASE });
    say("Agent for " + ad.label + " minted and saved to " + tokFile(ad.key) + ".");
  }
  if (!args.includes("--no-wire")) for (const ad of ads) await wire(ad);
  say("");
  say("Done. Run  npx @amkentech/agent-channel doctor  any time.");
}

// ---------------- init: detect, register, verify — the one command ----------------
async function init_() {
  const seeded = Object.values(ADAPTERS).some((a) => a.key !== "generic" && readTok(a.key)?.token) || process.env.AGENTCHAN_TOKEN;
  if (!seeded) {
    say("No Agent Channel token on this machine yet. Two ways in:");
    say("  already have a handle?   npx @amkentech/agent-channel signin <your-handle>        (a code goes to your verified email)");
    say('  new here?                npx @amkentech/agent-channel join <invite_code> <handle> "<Your Name>"');
    process.exit(1);
  }
  const ads = runtimesWanted();
  say("Detected: " + ads.map((a) => a.label).join(", "));
  for (const ad of ads) await wire(ad, opt("--token"));
  say("");
  await doctor();
}

// ---------------- who does a token actually belong to? ----------------
//
// A saved token is this runtime's token only if the SERVER agrees. Nothing used to check at all, and then the
// check that was added had two answers where it needed three.
//
// The probe deliberately does NOT go through api(): api() throws on any non-2xx, which collapses "the server
// says this token is dead" (401) into the same catch as "nobody answered". Those are opposite facts. It also
// used a 15-second timeout, so one unreachable runtime stalled wire for 15s and `--runtime all` multiplied
// that by every client on the machine.
const PROBE_MS = Number(process.env.AGENTCHAN_PROBE_MS || 6000);

async function probe1(path, token, ms) {
  try {
    const r = await fetch(BASE + path, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(ms) });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  } catch (e) {
    const code = e?.cause?.code || e?.code;
    return { status: 0, why: e?.name === "TimeoutError" ? "no answer in " + ms + "ms" : String(code || e?.message || e).slice(0, 90) };
  }
}

/** What the server says a token IS. Three answers, never two:
 *    { state: "ok", runtime, handle, agent_id }  the server looked and told us
 *    { state: "rejected", why }                  the server looked and says the token is dead (401/403)
 *    { state: "unknown", why }                   nobody could tell us: unreachable, hung, older build, odd shape
 *
 *  "unknown" must NEVER be read as a mismatch. A server that is down, or one built before GET /agents flagged
 *  the caller's own row with `this_one`, would otherwise re-mint an agent on every wire and spend the
 *  per-runtime cap of 4 in four runs. That is why the this_one row is required rather than falling back to the
 *  first row in the list -- `.find(a => a.this_one) || rows[0]` looks harmless, satisfies a source-text
 *  assertion, and turns every older server into a permanent false mismatch.
 *
 *  It must equally never be read as VERIFIED, which is what it was: one try/catch returning null meant 401,
 *  500, a 200 carrying an error body, an empty list, a missing this_one, a null runtime, a refused connection
 *  and a 15-second hang all printed byte-for-byte what a verified-correct token printed. */
async function identify(token, ms = PROBE_MS) {
  const [ag, pk] = await Promise.all([probe1("/agents", token, ms), probe1("/peek", token, ms)]);
  if (ag.status === 401 || ag.status === 403) return { state: "rejected", why: "HTTP " + ag.status + (ag.body?.error ? ", " + ag.body.error : "") };
  if (ag.status === 0) return { state: "unknown", why: ag.why };
  if (ag.status !== 200) return { state: "unknown", why: "HTTP " + ag.status + (ag.body?.error ? " " + String(ag.body.error).slice(0, 80) : "") };
  const rows = ag.body?.agents;
  if (!Array.isArray(rows)) return { state: "unknown", why: ag.body?.error ? "the server answered 200 with an error: " + String(ag.body.error).slice(0, 80) : "no agent list in the answer" };
  if (!rows.length) return { state: "unknown", why: "the server listed no agents for this token" };
  const mine = rows.find((a) => a && a.this_one);
  if (!mine) return { state: "unknown", why: "this server does not say which agent the token is (no this_one; a build older than 2026-08)" };
  if (!mine.runtime) return { state: "unknown", why: "the server did not say what runtime that agent is" };
  // /peek is the only unauthenticated-by-handle route that names the person. Whose token this is matters as
  // much as which runtime: a stranger's token with a matching runtime used to pass the check and be kept.
  const handle = pk.status === 200 && typeof pk.body?.handle === "string" ? pk.body.handle.replace(/^@/, "") : null;
  return { state: "ok", runtime: mine.runtime, agent_id: mine.id, handle };
}

/** Every handle the token store on this machine claims. "One identity, many runtimes" is the product's whole
 *  premise, so tokens here are all supposed to be one person's. */
function storedHandles() {
  const s = new Set();
  for (const k of Object.keys(ADAPTERS)) { const h = readTok(k)?.handle; if (h) s.add(String(h).replace(/^@/, "")); }
  return s;
}

/** Is this token this person's at all? Unknown is not wrong (the server may not have said), but a token the
 *  server attributes to somebody else is neither keepable NOR usable as a mint seed: minting with it would
 *  create an agent under THEIR identity, on their cap, in their audit ledger. */
function whoseToken(v, cand, known) {
  if (!v.handle) return { ok: true };
  if (cand.handle) return { ok: cand.handle === v.handle, expected: cand.handle };
  if (known.size && !known.has(v.handle)) return { ok: false, expected: [...known].join("/") };
  return { ok: true };
}

/** A credential of THIS person, good enough to mint a new agent with. Used only when this runtime has none. */
async function findSeed(known) {
  const cands = [];
  const seen = new Set();
  for (const k of Object.keys(ADAPTERS)) {
    const r = readTok(k);
    if (r?.token && !seen.has(r.token)) { seen.add(r.token); cands.push({ token: r.token, from: r.file || tokFile(k), handle: r.handle ? String(r.handle).replace(/^@/, "") : null }); }
  }
  const envTok = process.env.AGENTCHAN_TOKEN;
  if (envTok && !seen.has(envTok)) cands.push({ token: envTok, from: "the environment (AGENTCHAN_TOKEN)", handle: null });
  let unverified = null;
  for (const c of cands) {
    const v = await identify(c.token);
    if (v.state === "rejected") continue;
    if (v.state === "unknown") { unverified = unverified || { token: c.token, handle: c.handle }; continue; }
    const who = whoseToken(v, c, known);
    if (!who.ok) { warn("not minting with the token in " + c.from + ": the server says it is @" + v.handle + "'s, not @" + who.expected + "'s."); continue; }
    // The handle comes from the SAME token that is about to do the minting. It used to be read out of
    // readTok("claude") -- a different file from the token being used -- so a stale or foreign tok.claude.json
    // wrote the wrong person's name onto a perfectly good new agent, and every later "is this mine?" question
    // read that lie back.
    return { token: c.token, handle: v.handle || c.handle };
  }
  return unverified;
}

// ---------------- wire ----------------
let wiringIncomplete = false;

async function wire(ad, explicitToken) {
  const dry = args.includes("--dry-run");
  say("");
  say((dry ? "Would wire " : "Wiring ") + ad.label + ":");

  // --- 0. which credential is this runtime's own identity?
  // --dry-run runs this too. It used to skip the check entirely, which made the cautious preview the one mode
  // that could not see the problem it would fix. Everything here is read-only: two GETs, no mint, no writes.
  const known = storedHandles();
  let chosen = null;      // { token, handle, agent_id, verified }
  let seed = null;        // this person's, wrong runtime: mint material only
  for (const c of tokenCandidates(ad, explicitToken)) {
    const v = await identify(c.token);
    if (v.state === "unknown") {
      warn("could not verify this token against the server (" + v.why + "). Keeping it: an unreachable or older server is not evidence of a mismatch.");
      chosen = { token: c.token, handle: c.handle, verified: false };
      break;
    }
    if (v.state === "rejected") { bad("the token from " + c.from + " was rejected by the server (" + v.why + "). Not keeping it."); continue; }
    const who = whoseToken(v, c, known);
    if (!who.ok) { bad("the token from " + c.from + " belongs to @" + v.handle + ", not @" + who.expected + ". Not keeping it, and not minting with it."); continue; }
    if (v.runtime !== ad.runtime) {
      warn(ad.label + ": the saved token belongs to a '" + v.runtime + "' agent, not '" + ad.runtime + "'. "
        + "Minting this runtime its own agent -- sharing one would let it consume the other's handoffs. (source: " + c.from + ")");
      if (!seed) seed = { token: c.token, handle: v.handle || c.handle };
      continue;
    }
    ok("token verified as this runtime's own agent (" + v.runtime + (v.handle ? ", @" + v.handle : "") + ")");
    chosen = { token: c.token, handle: v.handle || c.handle, agent_id: v.agent_id, verified: true };
    break;
  }

  // --- 1. no identity yet: mint one for this runtime, using another of this person's tokens
  if (!chosen) {
    if (!seed) seed = await findSeed(known);
    if (!seed) bad("no token for " + ad.label + " and nothing to mint one with. New here: npx @amkentech/agent-channel join <code> <handle> \"<Name>\". Already have a handle: npx @amkentech/agent-channel signin <handle>.");
    else if (dry) say("  would: mint a new '" + ad.runtime + "' agent" + (seed.handle ? " for @" + seed.handle : "") + " and save it to " + tokFile(ad.key));
    else {
      try {
        const a2 = await api("/agents", { name: ad.key, runtime: ad.runtime }, seed.token);
        // The record is written once, in step 3 below, from `chosen`. It used to be written here too, with the
        // handle read out of readTok("claude") -- a DIFFERENT file from the token doing the minting -- so a
        // stale or foreign tok.claude.json put the wrong person's name on a perfectly good new agent. Two
        // writers of one field is how that survived; there is one now, and its handle comes from the server's
        // answer for the seed token itself.
        chosen = { token: a2.token, handle: seed.handle, agent_id: a2.id, verified: true };
        ok("minted its own agent (" + ad.runtime + ")" + (seed.handle ? " for @" + seed.handle : ""));
      } catch (e) {
        // A failed mint used to `return` from here -- above the MCP registration, the hooks, the slash
        // commands and the listener. A run that previously wired the client then wired NOTHING, said one
        // line, and exited 0. Everything that does not need a token is still wired below; the exit code says
        // the run did not finish the job.
        bad("could not mint a '" + ad.runtime + "' agent: " + e.message.slice(0, 160));
        warn("at the per-runtime cap? Ask your agent for  my_agents  and  revoke_agent <id>  on one you no longer use, then re-run this. Wiring the rest now; the MCP server needs a token and will be skipped.");
      }
    }
  }
  if (!chosen && !dry) wiringIncomplete = true;

  // --- 2. dry run stops here, having said what it found and what it would do
  if (dry) {
    if (chosen) say("  would: keep the token in " + tokFile(ad.key) + (chosen.verified ? " (verified)" : " (unverified: see above)"));
    const m = ad.mcpWire({ url: BASE, token: "<the token in " + tokFile(ad.key) + ">" });
    const hw = ad.hooksWire({ repo: REPO });
    say("  would: " + m.command.split(String.fromCharCode(10))[0]);
    if (ad.hooksFile) say("  would: " + (ad.hooksApply ? "write" : "merge") + " hooks into " + ad.hooksFile + " (" + Object.keys(hw.hooks || {}).join(", ") + ")"); else say("  note: " + (hw.note || "no hooks for this runtime"));
    if (ad.hooksFile && hw.note) say("  note: " + hw.note);
    if (ad.commandsWire) { const cw = ad.commandsWire({ repo: REPO }); say("  would: install slash commands to " + cw.dir + " (" + cw.files.map((f) => cw.invokeAs(f)).join(", ") + ")"); }
    if (ad.listener) say("  would: install the listener to start at login (" + (WIN ? "Startup folder + run_listen_" + ad.key + ".cmd" : platform() === "darwin" ? "LaunchAgent com.agentchannel.listen." + ad.key : "systemd --user unit") + ") and start it now");
    if (ad.listener && WIN) {
      const startup = startupDir();
      const present = startupListenerEntries(startup).filter((e) => e.canonical).map((e) => listenerKeys().find((k) => e.name.toLowerCase() === canonicalVbs(k)));
      for (const p of planLegacyStartupCleanup(startup, [...new Set([ad.key, ...present])])) say("  would: " + (p.action === "delete" ? "remove" : "drop the " + p.dropped.map((k) => "run_listen_" + k + ".cmd").join(", ") + " line(s) from") + " duplicate startup entry " + p.file);
      say("  would: " + (RELOCATED ? "skip the listener watchdog task (AGENTCHAN_HOME is set)" : "register the listener watchdog scheduled task " + WATCHDOG_TASK + " (every 10 min)"));
    }
    return;
  }

  // --- 3. token where the hooks and listener can find it
  if (chosen) {
    const rec = readTok(ad.key);
    if (!rec || rec.token !== chosen.token || (chosen.handle && rec.handle !== chosen.handle) || rec.runtime !== ad.runtime) {
      saveTok(ad.key, { handle: chosen.handle ?? rec?.handle ?? null, agent_id: chosen.agent_id ?? rec?.agent_id ?? null, runtime: ad.runtime, token: chosen.token, base: BASE });
    }
    // Pinning writes the machine's real user environment. A relocated store (AGENTCHAN_HOME) is by definition not
    // this machine's primary identity, so it must never be pinned there. refreshTokenEnv passes the token in the
    // child process environment, never argv -- setx put it on a command line, which is visible to other processes
    // and to agent tool output.
    if (WIN && !!ad.hooksFile && !RELOCATED) {
      const r = refreshTokenEnv(ad.key, chosen.token, { force: true });
      if (r.ok && r.state !== "absent") ok("user env var " + ad.tokenEnv + " " + (r.state === "current" ? "already current" : "set (new terminals; running ones keep the old value until restarted)"));
      else warn("could not set " + ad.tokenEnv + (r.why ? " (" + r.why + ")" : "") + "; the .tok file is enough for the hooks and listener");
    }
    else if (RELOCATED) warn("AGENTCHAN_HOME is set, so the token stays in " + tokFile(ad.key) + " and is not pinned into the user environment.");
    // No slice of the token, not even a prefix: this runs inside agents whose tool output leaves the machine.
    // The line below reads the value out of the file at paste time, in the shell that will actually run it.
    else warn("optional, to put it in your shell environment (the .tok file already covers the hooks and the listener):\n      " + tokenEnvHint(ad.key, { file: tokFile(ad.key), env: ad.tokenEnv }).command);
    const stale = process.env[ad.tokenEnv];
    if (stale && stale !== chosen.token) warn(ad.tokenEnv + " in this environment holds a DIFFERENT token from the one now saved. Until it is replaced, anything that reads the environment first keeps using the old one:\n      " + tokenEnvHint(ad.key, { file: tokFile(ad.key), env: ad.tokenEnv }).command);
  } else {
    warn("wiring the parts that need no token; the MCP server cannot be registered without one.");
  }
  // --- 4. MCP server in the client
  if (chosen) {
    const m = ad.mcpWire({ url: BASE, token: chosen.token, oauth: args.includes("--oauth") });
    const r = m.apply();
    // The printed fallback carries a placeholder, not the credential: apply() above used the real token, but
    // this line lands in agent-visible output.
    if (r.ok) ok("MCP server registered in " + ad.label + (r.note ? " (" + r.note + ")" : "")); else { warn("MCP not auto-registered (" + r.why + "). Run:\n      " + ad.mcpWire({ url: BASE, token: "<the token in " + tokFile(ad.key) + ">", oauth: args.includes("--oauth") }).command); }
  }
  // --- 5. hooks: these need no token, so a missing or unmintable identity must not skip them
  const hw = ad.hooksWire({ repo: REPO });
  // A runtime whose hook file is not JSON owns its own writer (grok's hooks live in ~/.grok/config.toml, and
  // JSON.stringify over that would replace the human's whole config with our object). Ask the adapter first.
  if (ad.hooksApply) {
    const r = ad.hooksApply({ repo: REPO });
    if (r.ok) ok("hooks written to " + ad.hooksFile + " (" + (r.wrote || []).join(", ") + ")");
    else bad("could not write hooks to " + ad.hooksFile + ": " + r.why);
    if (hw.note) warn(hw.note);
  } else if (ad.hooksFile && hw.hooks) {
    let cur = {}; try { cur = JSON.parse(readFileSync(ad.hooksFile, "utf8")); } catch {}
    const merged = mergeHooks(cur, hw);
    mkdirSync(dirname(ad.hooksFile), { recursive: true });
    writeFileSync(ad.hooksFile, JSON.stringify(merged, null, 2));
    ok("hooks merged into " + ad.hooksFile + " (" + Object.keys(hw.hooks).join(", ") + (hw.statusLine ? ", statusLine" : "") + ")");
    if (hw.note) warn(hw.note);
  } else if (hw.note) warn(hw.note);
  // --- 6. slash commands (source files in repo/commands/, copied as-is; dir/prefix/invokeAs are per-adapter in lib/adapters.mjs)
  // Guarded per file: a package missing its commands/ (the 0.8.1 break) must cost one warn line, never the listener step below.
  if (ad.commandsWire) {
    try {
      const cw = ad.commandsWire({ repo: REPO });
      mkdirSync(cw.dir, { recursive: true });
      const installed = [];
      for (const f of cw.files) {
        if (!existsSync(join(cw.source, f))) { warn("slash command source missing: " + f + " — " + cw.invokeAs(f) + " won't be available; re-run join/wire from a fresh npx"); continue; }
        writeFileSync(join(cw.dir, (cw.prefix || "") + f), readFileSync(join(cw.source, f), "utf8"));
        installed.push(f);
      }
      if (installed.length) ok("slash commands installed to " + cw.dir + " (" + installed.map((f) => cw.invokeAs(f)).join(", ") + ")");
    } catch (e) { warn("could not install slash commands: " + e.message); }
  }
  // --- 7. listener launcher + startup (Claude Desktop shares the Claude Code listener/token; nothing of its own)
  if (!ad.listener) { warn("no listener of its own; if Claude Code or Codex is wired on this machine its listener already covers toasts and files"); return; }
  if (DEPS_MISSING) { warn("listener not installed: its dependencies are missing. Fix:  cd " + REPO + " && npm install --omit=dev --ignore-scripts   then re-run: npx @amkentech/agent-channel wire"); return; }
  const cmdFile = join(REPO, "run_listen_" + ad.key + ".cmd");
  if (WIN) {
    if (!existsSync(cmdFile)) writeFileSync(cmdFile, "@echo off\r\ncd /d " + REPO + "\r\nnode scripts\\listen.mjs --runtime " + ad.key + " >> \"%USERPROFILE%\\.agentchan\\listen-" + ad.key + ".log\" 2>&1\r\n");
    const startup = startupDir();
    const vbs = join(startup, canonicalVbs(ad.key));
    try { mkdirSync(startup, { recursive: true }); writeFileSync(vbs, 'Set sh = CreateObject("WScript.Shell")\r\nsh.Run """' + cmdFile + '""", 0, False\r\n'); ok("listener starts at logon (" + vbs + ")"); }
    catch (e) { warn("could not write startup entry: " + e.message); }
    // A legacy all-listeners .vbs next to the canonical one starts this listener twice at logon, and the
    // watchdog then cannot attribute the second process and stops acting. Clean it for every runtime whose
    // canonical entry now exists, never for one whose only logon start is the legacy file.
    {
      const present = startupListenerEntries(startup).filter((e) => e.canonical).map((e) => listenerKeys().find((k) => e.name.toLowerCase() === canonicalVbs(k)));
      await applyLegacyStartupCleanup(planLegacyStartupCleanup(startup, [...new Set([ad.key, ...present])]));
    }
    // start now if not running
    if (!chosen) warn("not starting the listener: it has no token to connect with");
    else if (!listenerFresh(ad)) { try { spawn("wscript", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref(); ok("listener started now"); } catch { warn("start the listener: " + cmdFile); } }
    else ok("listener already running");
    // The watchdog restarts a listener that dies mid-session (the Startup entry only ever starts it at logon).
    // Registered through the script itself so there is one definition of the task; schtasks /F makes it
    // idempotent. A relocated store is not this machine's primary identity and gets no machine-level task,
    // the same rule that keeps it out of the user environment above.
    if (RELOCATED) warn("AGENTCHAN_HOME is set, so the listener watchdog scheduled task is not registered for this store.");
    else {
      try {
        execFileSync(process.execPath, [join(REPO, "scripts", "listener-watchdog.mjs"), "--install"], { cwd: REPO, stdio: "pipe", encoding: "utf8", timeout: 20000, windowsHide: true });
        ok("listener watchdog installed (every 10 min)");
      } catch (e) { warn("could not install the listener watchdog: " + String(e.stderr || e.stdout || e.message).trim().slice(0, 200) + "\n      run it yourself: npx @amkentech/agent-channel watchdog --install"); }
    }
  } else if (platform() === "darwin") {
    // macOS: a per-user LaunchAgent keeps the listener alive across logins (KeepAlive) and starts it now
    const label = "com.agentchannel.listen." + ad.key;
    const plistDir = join(H, "Library", "LaunchAgents"), plist = join(plistDir, label + ".plist");
    const nodeBin = which("node") || process.execPath;
    const logDir = join(H, ".agentchan"); mkdirSync(logDir, { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${nodeBin}</string><string>${join(REPO, "scripts", "listen.mjs")}</string><string>--runtime</string><string>${ad.key}</string></array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(logDir, "listen-" + ad.key + ".log")}</string>
  <key>StandardErrorPath</key><string>${join(logDir, "listen-" + ad.key + ".log")}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"}</string><key>HOME</key><string>${H}</string></dict>
</dict></plist>
`;
    try {
      mkdirSync(plistDir, { recursive: true }); writeFileSync(plist, xml);
      try { execFileSync("launchctl", ["bootout", "gui/" + process.getuid() + "/" + label], { stdio: "ignore" }); } catch {}
      try { execFileSync("launchctl", ["bootstrap", "gui/" + process.getuid(), plist], { stdio: "ignore" }); }
      catch { execFileSync("launchctl", ["load", "-w", plist], { stdio: "ignore" }); }
      ok("listener installed as LaunchAgent " + label + " (starts at login, restarts if it dies, log ~/.agentchan/listen-" + ad.key + ".log)");
    } catch (e) { warn("could not install the LaunchAgent (" + e.message.slice(0, 120) + "). Run by hand: node " + join(REPO, "scripts/listen.mjs") + " --runtime " + ad.key); }
  } else {
    // Linux: systemd --user unit when available, otherwise tell them how
    const unitDir = join(H, ".config", "systemd", "user"), unit = join(unitDir, "agent-channel-" + ad.key + ".service");
    const nodeBin = which("node") || process.execPath;
    if (which("systemctl")) {
      try {
        mkdirSync(unitDir, { recursive: true });
        writeFileSync(unit, "[Unit]\nDescription=Agent Channel listener (" + ad.key + ")\nAfter=network-online.target\n\n[Service]\nExecStart=" + nodeBin + " " + join(REPO, "scripts", "listen.mjs") + " --runtime " + ad.key + "\nWorkingDirectory=" + REPO + "\nRestart=always\nRestartSec=5\nEnvironment=HOME=" + H + "\n\n[Install]\nWantedBy=default.target\n");
        execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        execFileSync("systemctl", ["--user", "enable", "--now", "agent-channel-" + ad.key + ".service"], { stdio: "ignore" });
        ok("listener installed as systemd user service agent-channel-" + ad.key + " (enable-linger to survive logout: loginctl enable-linger $USER)");
      } catch (e) { warn("could not install the systemd unit (" + e.message.slice(0, 120) + "). Run by hand: node " + join(REPO, "scripts/listen.mjs") + " --runtime " + ad.key); }
    } else warn("run the listener in the background:  node " + join(REPO, "scripts/listen.mjs") + " --runtime " + ad.key + "   (tmux/nohup; the token is read from ~/.agentchan/tok." + ad.key + ".json)");
  }
}

const startHint = (ad) => WIN ? "run_listen_" + ad.key + ".cmd (in " + REPO + ")" : platform() === "darwin" ? "launchctl kickstart -k gui/$(id -u)/com.agentchannel.listen." + ad.key + "  (or: agent-channel wire)" : "systemctl --user restart agent-channel-" + ad.key + "  (or: agent-channel wire)";
function ownerHandle(ad) {
  const root = join(H, ".agentchan");
  try { for (const h of readdirSync(root)) { try { if (readFileSync(join(root, h, "owner." + ad.key), "utf8") === "1") return h; } catch {} } } catch {}
  return null;
}
function listenerFresh(ad) {
  const h = ownerHandle(ad); if (!h) return false;
  const fresh = (f, ms) => { try { return Date.now() - statSync(join(H, ".agentchan", h, f)).mtimeMs < ms; } catch { return false; } };
  return fresh("heartbeat", 3 * 60_000) || fresh("peek.json", 10 * 60_000); // heartbeat every 30s (listeners started before v0.3 only refresh peek.json on events)
}

// ---------------- doctor ----------------
async function doctor() {
  say("Agent Channel doctor  (server " + BASE + ")");
  // The first line has always printed BASE; it never said when BASE was not the real server, and an
  // AGENTCHAN_URL left over from a test or a local build makes every check below report on the wrong machine.
  if (BASE !== DEFAULT_BASE) warn("server URL overridden to " + BASE + " by AGENTCHAN_URL; the canonical address is " + DEFAULT_BASE);
  try { const h = await api("/health"); ok("server reachable, listeners connected: " + h.listeners); } catch (e) { bad("server unreachable: " + e.message); }
  // A credential file named for a runtime no adapter knows is invisible to every path that resolves tokens by
  // adapter key (tok.copilot-cli.json on this machine, while the key is copilot): the runtime it was minted
  // for runs unwired, and the token sits on disk unused and unchecked.
  {
    let files = []; try { files = readdirSync(HOME_STORE).filter((f) => /^tok\..+\.json$/.test(f)); } catch {}
    const known = Object.keys(ADAPTERS);
    for (const f of files) {
      const key = f.slice("tok.".length, -".json".length);
      if (!known.includes(key)) warn(join(HOME_STORE, f) + " holds a credential for unknown runtime '" + key + "'; known keys: " + known.join(", ") + "; rename it to tok.<key>.json for the runtime it belongs to, or delete it");
    }
  }
  // Windows logon starts: a listener referenced by two Startup entries runs twice, and the watchdog refuses to
  // act on a process it cannot attribute. Then the watchdog task itself, without which a listener that dies
  // mid-session stays dead until the next logon.
  {
    const startup = startupDir();
    const entries = startupListenerEntries(startup);
    for (const k of listenerKeys()) {
      const refs = entries.filter((e) => e.keys.includes(k));
      if (refs.length > 1) bad("listener '" + k + "' is started " + refs.length + " times at logon (" + refs.map((e) => e.name).join(", ") + "); run: npx @amkentech/agent-channel wire --runtime " + k);
    }
    if (WIN && RELOCATED) warn("listener watchdog check skipped (AGENTCHAN_HOME is set; the task belongs to the machine's primary store)");
    else if (WIN) {
      let installed = false;
      try { execFileSync("schtasks", ["/Query", "/TN", WATCHDOG_TASK], { stdio: "pipe", windowsHide: true, timeout: 15000 }); installed = true; } catch {}
      if (installed) ok("listener watchdog scheduled task present (" + WATCHDOG_TASK + ")");
      else warn("listener watchdog not installed; a listener that dies mid-session stays dead until logon. Fix: npx @amkentech/agent-channel watchdog --install");
    }
  }
  // A stored credential is checkable whether or not its CLI is. Gating every check on detect() made doctor
  // blind to the thing it exists to find: a live token on a machine where the client is not detectable (not
  // on PATH, or not installed at all -- on the CI runner three doctor tests failed for exactly this reason:
  // the loop below never ran). So a runtime with a token in the store is checked even when its CLI is not
  // found; only the wiring, hook, and listener checks -- which need the client itself -- are skipped, out loud.
  const all = Object.values(ADAPTERS).filter((a) => a.key !== "generic");
  const detected = new Set(all.filter((a) => a.detect()));
  if (!detected.size) warn("no agent CLI detected (Claude Code, Codex, Claude Desktop, Cursor, Gemini CLI, Windsurf, Grok CLI)");
  const ads = all.filter((a) => detected.has(a) || readTok(a.key)?.token);
  for (const ad of ads) {
    say("");
    say(ad.label + ":");
    if (!detected.has(ad)) warn("client CLI not detected, but " + tokFile(ad.key) + " holds a credential -- checking the token");
    const token = tokenFor(ad);
    if (!token) { bad("no token (" + ad.tokenEnv + " or " + tokFile(ad.key) + "). Already have a handle: npx @amkentech/agent-channel signin <handle> --runtime " + ad.key + ". New: npx @amkentech/agent-channel join <code> <handle> \"<Name>\" --runtime " + ad.key); continue; }
    let me = null;
    try { me = await api("/peek", null, token); ok("token valid, you are @" + me.handle + " (" + (me.unread_messages + me.proposals_awaiting_you + me.artifacts_waiting) + " waiting)"); }
    catch (e) { bad("token rejected: " + e.message + (e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : "")); }
    // The environment and the tok file are two stores of the same credential, and they DRIFT: wire pinned the
    // env var, a later remint rewrote only the file, and everything env-first (the hooks, the listener) kept
    // authenticating with the dead token for nine hours while doctor's line above -- which reads env-first
    // too -- was the only symptom. Name the split explicitly: which store is current, which is stale, and
    // that a stale ENVIRONMENT wins over a good file until it is refreshed. Distinct from "token rejected"
    // (no working credential anywhere) and from the baked-MCP-header line (a different identity entirely).
    {
      const envTok = process.env[ad.tokenEnv];
      const fileTok = readTok(ad.key)?.token || null;
      if (envTok && fileTok && envTok !== fileTok) {
        const probe = async (t) => { try { await api("/peek", null, t); return true; } catch { return false; } };
        const envOk = await probe(envTok), fileOk = await probe(fileTok);
        if (!envOk && fileOk) bad("env var " + ad.tokenEnv + " holds a stale token; " + tokFile(ad.key) + " is current. Anything env-first is deaf until it is refreshed. Fix: npx @amkentech/agent-channel wire --runtime " + ad.key + ", then restart open terminals.");
        else if (envOk && !fileOk) warn(tokFile(ad.key) + " holds a stale token; the environment (" + ad.tokenEnv + ") is current. Re-run wire to rewrite the file.");
        else warn(ad.tokenEnv + " and " + tokFile(ad.key) + " hold DIFFERENT tokens (both " + (envOk ? "accepted" : "rejected") + " by the server). Anything env-first uses the environment one; re-run wire to converge them.");
      }
    }
    // "valid" is not the same as "this runtime's". A token can authenticate perfectly and still be another
    // runtime's agent -- which is the whole failure this file's wire path exists to fix, and which doctor
    // could not see: it asked /peek, which answers for the person, and never asked which AGENT the token is.
    // The same three states as wire: could-not-verify says so rather than passing silently.
    const id = await identify(token);
    if (id.state === "ok" && id.runtime !== ad.runtime) bad("this token is a '" + id.runtime + "' agent, not '" + ad.runtime + "'. It reads and can ACK that runtime's mail. Fix: npx @amkentech/agent-channel wire --runtime " + ad.key);
    else if (id.state === "ok") ok("token is this runtime's own agent (" + id.runtime + ")");
    else if (id.state === "unknown") warn("could not verify which agent this token is (" + id.why + ")");
    if (!detected.has(ad)) { warn("wiring, hook, and listener checks skipped (client CLI not found on this machine)"); continue; }
    // Display placeholder, never the credential: this command is PRINTED (into a terminal that is often an
    // agent's tool output), and check()/auth() read the client's config, not the token argument. The dry-run
    // path made the same substitution for the same reason.
    const m = ad.mcpWire({ url: BASE, token: "<the token in " + tokFile(ad.key) + ">" }); const c = m.check();
    if (c === true) ok("MCP server registered"); else if (c === false) bad("MCP server not registered. " + (ad.key === "claude-desktop" ? "Run: npx @amkentech/agent-channel wire --runtime desktop   (or Desktop > Settings > Connectors > Add custom connector > " + BASE + "/mcp)" : m.command.split(String.fromCharCode(10))[0])); else warn("could not check MCP registration (client CLI not on PATH)");
    if (typeof m.auth === "function") {
      const a = m.auth();
      if (a?.mode === "baked") bad("MCP Authorization is a baked token, not ${" + ad.tokenEnv + "}. This runtime can silently borrow another identity. Fix: npx @amkentech/agent-channel wire --runtime " + ad.key);
      else if (a?.mode === "env") ok("MCP Authorization reads " + ad.tokenEnv);
      else if (a?.mode === "missing" && c === true) bad("MCP Authorization is missing. " + ad.label + " would connect with no token. Fix: npx @amkentech/agent-channel wire --runtime " + ad.key);
    }
    if (ad.hooksFile) {
      let txt = ""; try { txt = readFileSync(ad.hooksFile, "utf8"); } catch {}
      const has = (name) => txt.includes("hooks/" + name) || txt.includes("hooks\\\\" + name) || txt.includes("hooks\\" + name);
      // Ask the adapter whether it wires this at all before calling its absence a fault. grok deliberately does
      // not: its UserPromptSubmit ignores hook stdout and exit codes, so type-to-send cannot block the prompt
      // and would double-send every message through the model. Reporting that as a missing hook would send a
      // human to re-run wire forever; reporting nothing would read as full coverage. So it says which it is.
      if (wiresHook(ad, "inbox.mjs")) has("inbox.mjs") ? ok("inbox hook (type-to-send + waiting banner) wired") : bad("inbox hook missing in " + ad.hooksFile + "  (npx @amkentech/agent-channel wire --runtime " + ad.key + ")");
      else warn("no inbox hook on this runtime by design: typing @handle does NOT send here, and no waiting banner is shown. Mail arrives when the model reads my_inbox (the server attaches new mail to tool results).");
      if (ad.supportsFileChanged) has("notify.mjs") ? ok("idle notifications (FileChanged) wired") : warn("FileChanged notify hook missing");
      if (wiresHook(ad, "btw.mjs")) has("btw.mjs") ? ok("mid-turn arrivals wired") : warn("mid-turn arrival hook missing (messages wait for your next prompt): npx @amkentech/agent-channel wire --runtime " + ad.key);
      if (ad.supportsPreExec) has("secret-guard.mjs") ? ok("credential guard (PreToolUse) wired") : warn("credential guard missing (an agent could put a secret on a command line): npx @amkentech/agent-channel wire --runtime " + ad.key);
      if (wiresHook(ad, "claude-status.mjs")) has("claude-status.mjs") ? ok("status hooks wired") : warn("status hooks missing");
    }
    // Codex has no post-tool hook, so mid-turn delivery runs the other way round: the resident listener pushes
    // into a live Codex thread over the app-server WebSocket. Three links, and the last is a human habit - the
    // TUI must be started with codex-remote.cmd. Miss it and the first two still look perfect while every push
    // is dropped. Report the OUTCOME, not the wiring: on 2026-08-27 this path had delivered 0 of 16 attempts
    // here and doctor called Codex fully wired throughout, because the only evidence was a line in a log file.
    if (ad.key === "codex") {
      let launcher = ""; try { launcher = readFileSync(join(REPO, "run_listen_codex.cmd"), "utf8"); } catch {}
      const ws = configuredWs(launcher, process.env);
      const { host, port } = wsHostPort(ws.url);
      const reach = await probe(host, port);
      const attached = reach.reachable ? await probeLoadedThread(ws.url) : { loaded: false, reason: reach.reason };
      let logTxt = ""; try { logTxt = readFileSync(join(HOME_STORE, "listen-codex.log"), "utf8"); } catch {}
      const summary = summarizePushLog(logTxt);
      const v = pushVerdict({ summary, reachable: reach.reachable, loaded: attached.loaded });
      (reach.reachable ? ok : warn)("app-server " + (reach.reachable ? "reachable" : "not reachable (" + (reach.reason || "?") + ")") + " at " + ws.url + " (from " + ws.source + ")");
      (attached.loaded ? ok : warn)(attached.loaded ? "loaded Codex thread available (" + attached.threadId.slice(0, 8) + ")" : "no loaded Codex thread available (" + (attached.reason || "unknown") + ")");
      (v.level === "ok" ? ok : v.level === "warn" ? warn : bad)("mid-turn delivery: " + v.text);
    }
    // What the hook SWALLOWED. The hook is silent on failure on purpose - it must never break a prompt - so
    // before 2026-08-27 a rejected token, an unreachable server or an unwritable state file left no trace at
    // all, and the banner just quietly stopped working. It now records each one; this is where a human finally
    // sees them. Silence about the silence was the actual defect.
    const swallowed = summarizeDiag(readDiag(HOME_STORE, ad.key, 200));
    if (swallowed.length) {
      warn("this hook swallowed " + swallowed.reduce((n, x) => n + x.count, 0) + " failure(s) recently (diag-" + ad.key + ".jsonl):");
      for (const x of swallowed.slice(0, 5)) say("     " + x.step + " x" + x.count + "  last: " + (x.last_err || "?") + "  at " + (x.last_at || "?"));
    } else ok("no swallowed failures recorded");
    // Say what this runtime CANNOT do, out loud. The 2026-08-22 credential leak happened in a runtime with no
    // pre-execution hook; nothing installable here could have blocked it, and pretending otherwise is worse
    // than the gap. A pass with no stated scope reads as full coverage.
    if (!ad.supportsPreExec) warn("this runtime cannot block a credential on a command line (no pre-execution hook). The guard only covers runtimes with one; here, keep secrets in env vars/stdin and rotate with a script that never prints them.");
    if (ad.commandsWire) {
      const cw = ad.commandsWire({ repo: REPO });
      const have = cw.files.every((f) => existsSync(join(cw.dir, (cw.prefix || "") + f)));
      have ? ok("slash commands wired (" + cw.files.map((f) => cw.invokeAs(f)).join(", ") + ")") : bad("slash commands missing in " + cw.dir + "  (npx @amkentech/agent-channel wire --runtime " + ad.key + ")");
    }
    if (!ad.listener) continue;
    const h = ownerHandle(ad);
    if (!h) bad("listener has never connected for this runtime (no owner marker). Start it: " + startHint(ad));
    else if (listenerFresh(ad)) ok("listener running as @" + h);
    else bad("listener not running or started before v0.3 (no fresh heartbeat). Restart it: " + startHint(ad));
    if (h) {
      // E2E key health: fingerprint every local key and cross-check it against the server's registry, so a revoked or
      // unregistered key is a doctor finding, not a mystery at send time. Retired keys (kept after rotate so old
      // artifacts still decrypt) are expected to be revoked server-side and are skipped.
      const { loadLocalKeys } = await import("../lib/crypto.mjs");
      const { createHash } = await import("node:crypto");
      const fp = (pub) => createHash("sha256").update(String(pub)).digest("hex").match(/.{4}/g).slice(0, 4).join(" ");
      const local = loadLocalKeys(h).filter((k) => !String(k.label || "").includes("-retired-"));
      if (!local.length) warn("no E2E key yet; the listener registers one on first connect (or: node scripts/artifact.mjs keygen)");
      else if (token) {
        try {
          const mine = await api("/keys", null, token);
          for (const k of local) {
            const s = mine.keys.find((x) => x.id === k.key_id);
            if (s && !s.revoked_at) ok("E2E key " + fp(k.public_key) + "  " + (k.label || "") + " (registered; files can be received)");
            else if (s?.revoked_at) bad("local key " + fp(k.public_key) + "  " + (k.label || "") + " was REVOKED on the server " + String(s.revoked_at).slice(0, 10) + ". Rotate: node scripts/artifact.mjs rotate");
            else warn("local key " + fp(k.public_key) + "  " + (k.label || "") + " is not registered on the server (the listener registers it on connect, or: node scripts/artifact.mjs keygen)");
          }
          const elsewhere = mine.keys.filter((x) => !x.revoked_at && !loadLocalKeys(h).some((k) => k.key_id === x.id));
          if (elsewhere.length) warn(elsewhere.length + " other active key(s) registered for you (other devices/runtimes): " + elsewhere.map((x) => fp(x.public_key) + " " + (x.label || x.runtime || "")).join(", ") + ". Lost a device? node scripts/artifact.mjs revoke-key <id>");
        } catch { ok("E2E key present locally (" + local.map((k) => fp(k.public_key)).join(", ") + "); could not cross-check the server"); }
      } else ok("E2E key present locally (" + local.map((k) => fp(k.public_key)).join(", ") + "); no valid token to cross-check the server");
    }
    if (me && ad.key === "claude") {
      const cc = which("claude"); if (!cc) warn("claude CLI not on PATH (fine if you use the desktop app)");
    }
  }
  say("");
  say("Type  @<handle> hello  in a prompt to send a message with no model turn. Ask your agent for  my_work  to see the ledger.");
}

if (cmd === "join") await join_();
else if (cmd === "signin") await signin_();
else if (cmd === "init") await init_();
else if (cmd === "wire") { const ads = runtimesWanted(); for (const ad of ads) await wire(ad, opt("--token")); }
else if (cmd === "doctor" || cmd === "status") await doctor();
else { say("usage: npx @amkentech/agent-channel join <inv_code> <handle> \"<Display Name>\" [--runtime claude|codex|grok|all] [--email x]\n       npx @amkentech/agent-channel signin <handle> [--runtime ...]        existing identity, new machine or runtime\n       npx @amkentech/agent-channel init                                     detect every agent CLI, register into each, verify\n       npx @amkentech/agent-channel wire [--runtime claude|codex|desktop|grok|all] [--token ac_...] [--oauth] [--dry-run]\n       npx @amkentech/agent-channel doctor"); process.exit(1); }

// A run that could not give a runtime its own identity has not done the job it was asked to do. It used to
// say one line and exit 0, which is indistinguishable from success to anything scripting this.
if (wiringIncomplete) process.exitCode = 1;
