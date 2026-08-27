#!/usr/bin/env node
// One-command onboarding and health check for a person joining Agent Channel.
//
//   node scripts/setup.mjs join <inv_code> <handle> "<Display Name>" [--runtime claude|codex|all] [--email you@x.com]
//        -> creates your identity + one agent token per DETECTED runtime (Claude Code, Codex, Desktop, Cursor, Gemini,
//           Windsurf), connected to whoever invited you, then wires everything below
//   node scripts/setup.mjs signin <handle> [--runtime ...]
//        -> you already exist; a NEW MACHINE or runtime gets its own token via a code emailed to your verified address.
//           One identity, many runtimes: never a second handle.
//   node scripts/setup.mjs init
//        -> the one command: token on this machine? detect every agent CLI, register into each, verify. No token? it
//           says which of join/signin applies.
//   node scripts/setup.mjs wire [--runtime claude|codex] [--token ac_...]
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
import { readTok as readTokStore, saveTok as saveTokStore, tokFileHome, CLIENT_HOME, IN_NPX_CACHE, HOME_STORE } from "../lib/paths.mjs";

let REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Running from an npx cache (npx @amkentech/agent-channel join ...)? That folder can vanish, and hooks/listener need a stable path:
// copy this package to ~/.agentchan/client and run from there. A git checkout or a global install stays where it is.
if (IN_NPX_CACHE && !process.env.AGENTCHAN_NO_SELF_INSTALL) {
  const { cpSync } = await import("node:fs");
  cpSync(REPO, CLIENT_HOME, { recursive: true, force: true, filter: (src) => !/[\\/](\.git|\.tok\.[^\\/]+\.json|\.env[^\\/]*)$/.test(src) });
  // the listener needs the package's own deps (ws, MCP sdk); hooks need none. Install them once in the persistent copy.
  try { const { execFileSync: x } = await import("node:child_process"); x(platform() === "win32" ? "npm.cmd" : "npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent"], { cwd: CLIENT_HOME, stdio: "ignore", shell: platform() === "win32" }); }
  catch { console.log("  note: could not npm install in " + CLIENT_HOME + "; run it there by hand before starting the listener"); }
  console.log("  installed client to " + CLIENT_HOME + " (hooks and the listener run from there; re-run join/wire from any npx to update)");
  REPO = CLIENT_HOME;
}
const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const H = homedir();
const WIN = platform() === "win32";
const say = (s) => console.log(s);
const ok = (s) => say("  ok   " + s);
const bad = (s) => say("  MISSING  " + s);
const warn = (s) => say("  note " + s);

const tokFile = (key) => tokFileHome(key);            // tokens live in ~/.agentchan, not next to the code
const readTok = (key) => readTokStore(key);
const saveTok = (key, obj) => saveTokStore(key, obj);
const tokenFor = (ad) => process.env[ad.tokenEnv] || readTok(ad.key)?.token || (ad.key === "claude-desktop" ? readTok("claude")?.token : null) || null;

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
  if (r === "all") return [ADAPTERS.claude, ADAPTERS.codex, ADAPTERS["claude-desktop"], ADAPTERS.cursor, ADAPTERS.gemini, ADAPTERS.windsurf].filter((a) => a.detect());
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
  if (!code || !handle || !display_name) { say('usage: setup.mjs join <inv_code> <handle> "<Display Name>" [--runtime claude|codex|all] [--email you@x.com]   (default: every detected client)'); process.exit(1); }
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
  if (!args.includes("--no-wire")) for (const ad of ads) await wire(ad, tokenFor(ad));
  say("");
  say("Done. Open " + ads.map((a) => a.label).join(" or ") + " and type:   @" + j.connected_to.replace(/^@/, "") + " hi, I'm in.");
  say("Then run  node scripts/setup.mjs doctor  any time.");
}

// ---------------- signin: this person already exists; a new machine or runtime gets its own token ----------------
// The server side is /signin/start + /signin/finish (src/oauth.js): handle -> 6-digit code to the VERIFIED email ->
// agent token, the same hardened flow as the OAuth consent page. This is the path that prevents the second-handle
// mistake: an existing identity extends to a new machine instead of joining again as someone else.
async function signin_() {
  const positional = args.slice(1).filter((x, i, arr) => !x.startsWith("--") && arr[i - 1] !== "--runtime" && arr[i - 1] !== "--token");
  const handle = (positional[0] || "").replace(/^@/, "").toLowerCase();
  if (!handle) { say("usage: setup.mjs signin <handle> [--runtime claude|codex|all]   (a code goes to the email you verified with verify_email)"); process.exit(1); }
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
    if (j.reset) { rl.close(); say("Start over:  node scripts/setup.mjs signin " + handle); process.exit(1); }
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
  if (!args.includes("--no-wire")) for (const ad of ads) await wire(ad, tokenFor(ad));
  say("");
  say("Done. Run  node scripts/setup.mjs doctor  any time.");
}

// ---------------- init: detect, register, verify — the one command ----------------
async function init_() {
  const seeded = Object.values(ADAPTERS).some((a) => a.key !== "generic" && readTok(a.key)?.token) || process.env.AGENTCHAN_TOKEN;
  if (!seeded) {
    say("No Agent Channel token on this machine yet. Two ways in:");
    say("  already have a handle?   node scripts/setup.mjs signin <your-handle>        (a code goes to your verified email)");
    say('  new here?                node scripts/setup.mjs join <invite_code> <handle> "<Your Name>"');
    process.exit(1);
  }
  const ads = runtimesWanted();
  say("Detected: " + ads.map((a) => a.label).join(", "));
  for (const ad of ads) await wire(ad, opt("--token") || tokenFor(ad));
  say("");
  await doctor();
}

// ---------------- wire ----------------
async function wire(ad, token) {
  if (!token) {
    // no token for this runtime yet, but the person is already here under another: mint an agent for this runtime
    const seed = readTok("claude")?.token || readTok("codex")?.token || process.env.AGENTCHAN_TOKEN || null;
    if (seed && !args.includes("--dry-run")) {
      try { const a2 = await api("/agents", { name: ad.key, runtime: ad.runtime }, seed); const h = readTok("claude")?.handle || readTok("codex")?.handle || null; saveTok(ad.key, { handle: h, agent_id: a2.id, runtime: ad.runtime, token: a2.token, base: BASE }); token = a2.token; ok(ad.label + ": minted its own agent (" + ad.runtime + ") for your handle"); }
      catch (e) { bad(ad.label + ": could not mint an agent (" + e.message.slice(0, 120) + ")"); return; }
    } else if (seed) { token = seed; }
    else { bad(ad.label + ": no token. Pass --token or join first."); return; }
  }
  say("");
  say("Wiring " + ad.label + ":");
  if (args.includes("--dry-run")) {
    const m = ad.mcpWire({ url: BASE, token: token ? token.slice(0, 6) + "..." : token }); const hw = ad.hooksWire({ repo: REPO });
    say("  would: save token to " + tokFile(ad.key) + (WIN && ["claude", "codex"].includes(ad.key) ? " and setx " + ad.tokenEnv : ""));
    say("  would: " + m.command.split(String.fromCharCode(10))[0]);
    if (ad.hooksFile) say("  would: merge hooks into " + ad.hooksFile + " (" + Object.keys(hw.hooks || {}).join(", ") + ")"); else say("  note: " + (hw.note || "no hooks for this runtime"));
    if (ad.commandsWire) { const cw = ad.commandsWire({ repo: REPO }); say("  would: install slash commands to " + cw.dir + " (" + cw.files.map((f) => cw.invokeAs(f)).join(", ") + ")"); }
    if (ad.key !== "claude-desktop") say("  would: install the listener to start at login (" + (WIN ? "Startup folder + run_listen_" + ad.key + ".cmd" : platform() === "darwin" ? "LaunchAgent com.agentchannel.listen." + ad.key : "systemd --user unit") + ") and start it now");
    return;
  }
  // 1. token where the hooks and listener can find it
  if (!readTok(ad.key)) saveTok(ad.key, { token, runtime: ad.runtime, base: BASE });
  if (WIN && ["claude", "codex"].includes(ad.key)) { try { execFileSync("setx", [ad.tokenEnv, token], { stdio: "ignore" }); ok("user env var " + ad.tokenEnv + " set (new terminals)"); } catch { warn("could not setx " + ad.tokenEnv + "; the .tok file is enough for the hooks and listener"); } }
  else warn("export " + ad.tokenEnv + "=" + token.slice(0, 8) + "... in your shell profile (the .tok file covers hooks/listener)");
  // 2. MCP server in the client
  const m = ad.mcpWire({ url: BASE, token, oauth: args.includes("--oauth") });
  const r = m.apply();
  if (r.ok) ok("MCP server registered in " + ad.label + (r.note ? " (" + r.note + ")" : "")); else { warn("MCP not auto-registered (" + r.why + "). Run:\n      " + m.command); }
  // 3. hooks
  const hw = ad.hooksWire({ repo: REPO });
  if (ad.hooksFile && hw.hooks) {
    let cur = {}; try { cur = JSON.parse(readFileSync(ad.hooksFile, "utf8")); } catch {}
    const merged = mergeHooks(cur, hw);
    mkdirSync(dirname(ad.hooksFile), { recursive: true });
    writeFileSync(ad.hooksFile, JSON.stringify(merged, null, 2));
    ok("hooks merged into " + ad.hooksFile + " (" + Object.keys(hw.hooks).join(", ") + (hw.statusLine ? ", statusLine" : "") + ")");
    if (hw.note) warn(hw.note);
  } else if (hw.note) warn(hw.note);
  // 3.5 slash commands (source files in repo/commands/, copied as-is; dir/prefix/invokeAs are per-adapter in lib/adapters.mjs)
  if (ad.commandsWire) {
    const cw = ad.commandsWire({ repo: REPO });
    mkdirSync(cw.dir, { recursive: true });
    for (const f of cw.files) writeFileSync(join(cw.dir, (cw.prefix || "") + f), readFileSync(join(cw.source, f), "utf8"));
    ok("slash commands installed to " + cw.dir + " (" + cw.files.map((f) => cw.invokeAs(f)).join(", ") + ")");
  }
  // 4. listener launcher + startup (Claude Desktop shares the Claude Code listener/token; nothing of its own)
  if (["claude-desktop", "cursor", "gemini", "windsurf"].includes(ad.key)) { warn("no listener of its own; if Claude Code or Codex is wired on this machine its listener already covers toasts and files"); return; }
  const cmdFile = join(REPO, "run_listen_" + ad.key + ".cmd");
  if (WIN) {
    if (!existsSync(cmdFile)) writeFileSync(cmdFile, "@echo off\r\ncd /d " + REPO + "\r\nnode scripts\\listen.mjs --runtime " + ad.key + " >> \"%USERPROFILE%\\.agentchan\\listen-" + ad.key + ".log\" 2>&1\r\n");
    const startup = join(process.env.APPDATA || join(H, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const vbs = join(startup, "agent-channel-" + ad.key + ".vbs");
    try { mkdirSync(startup, { recursive: true }); writeFileSync(vbs, 'Set sh = CreateObject("WScript.Shell")\r\nsh.Run """' + cmdFile + '""", 0, False\r\n'); ok("listener starts at logon (" + vbs + ")"); }
    catch (e) { warn("could not write startup entry: " + e.message); }
    // start now if not running
    if (!listenerFresh(ad)) { try { spawn("wscript", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref(); ok("listener started now"); } catch { warn("start the listener: " + cmdFile); } }
    else ok("listener already running");
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
  try { const h = await api("/health"); ok("server reachable, listeners connected: " + h.listeners); } catch (e) { bad("server unreachable: " + e.message); }
  const ads = Object.values(ADAPTERS).filter((a) => a.key !== "generic" && a.detect());
  if (!ads.length) warn("no agent CLI detected (Claude Code, Codex, Claude Desktop, Cursor, Gemini CLI, Windsurf)");
  for (const ad of ads) {
    say("");
    say(ad.label + ":");
    const token = tokenFor(ad);
    if (!token) { bad("no token (" + ad.tokenEnv + " or " + tokFile(ad.key) + "). Already have a handle: setup.mjs signin <handle> --runtime " + ad.key + ". New: setup.mjs join <code> <handle> \"<Name>\" --runtime " + ad.key); continue; }
    let me = null;
    try { me = await api("/peek", null, token); ok("token valid, you are @" + me.handle + " (" + (me.unread_messages + me.proposals_awaiting_you + me.artifacts_waiting) + " waiting)"); }
    catch (e) { bad("token rejected: " + e.message + (e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : "")); }
    const m = ad.mcpWire({ url: BASE, token }); const c = m.check();
    if (c === true) ok("MCP server registered"); else if (c === false) bad("MCP server not registered. " + (ad.key === "claude-desktop" ? "Run: node scripts/setup.mjs wire --runtime desktop   (or Desktop > Settings > Connectors > Add custom connector > " + BASE + "/mcp)" : m.command.split(String.fromCharCode(10))[0])); else warn("could not check MCP registration (client CLI not on PATH)");
    if (ad.hooksFile) {
      let txt = ""; try { txt = readFileSync(ad.hooksFile, "utf8"); } catch {}
      const has = (name) => txt.includes("hooks/" + name) || txt.includes("hooks\\\\" + name) || txt.includes("hooks\\" + name);
      has("inbox.mjs") ? ok("inbox hook (type-to-send + waiting banner) wired") : bad("inbox hook missing in " + ad.hooksFile + "  (setup.mjs wire --runtime " + ad.key + ")");
      if (ad.supportsFileChanged) has("notify.mjs") ? ok("idle notifications (FileChanged) wired") : warn("FileChanged notify hook missing");
      if (ad.key === "claude") has("btw.mjs") ? ok("mid-turn arrivals (PostToolUse) wired") : warn("mid-turn arrival hook missing (messages wait for your next prompt): setup.mjs wire --runtime claude");
      if (ad.supportsPreExec) has("secret-guard.mjs") ? ok("credential guard (PreToolUse) wired") : warn("credential guard missing (an agent could put a secret on a command line): setup.mjs wire --runtime " + ad.key);
      if (ad.key === "claude") has("claude-status.mjs") ? ok("status hooks wired") : warn("status hooks missing");
    }
    // Say what this runtime CANNOT do, out loud. The 2026-08-22 credential leak happened in a runtime with no
    // pre-execution hook; nothing installable here could have blocked it, and pretending otherwise is worse
    // than the gap. A pass with no stated scope reads as full coverage.
    if (!ad.supportsPreExec) warn("this runtime cannot block a credential on a command line (no pre-execution hook). The guard only covers runtimes with one; here, keep secrets in env vars/stdin and rotate with a script that never prints them.");
    if (ad.commandsWire) {
      const cw = ad.commandsWire({ repo: REPO });
      const have = cw.files.every((f) => existsSync(join(cw.dir, (cw.prefix || "") + f)));
      have ? ok("slash commands wired (" + cw.files.map((f) => cw.invokeAs(f)).join(", ") + ")") : bad("slash commands missing in " + cw.dir + "  (setup.mjs wire --runtime " + ad.key + ")");
    }
    if (["claude-desktop", "cursor", "gemini", "windsurf"].includes(ad.key)) continue;
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
else if (cmd === "wire") { const ads = runtimesWanted(); for (const ad of ads) await wire(ad, opt("--token") || tokenFor(ad)); }
else if (cmd === "doctor" || cmd === "status") await doctor();
else { say("usage: setup.mjs join <inv_code> <handle> \"<Display Name>\" [--runtime claude|codex|all] [--email x]\n       setup.mjs signin <handle> [--runtime ...]        existing identity, new machine or runtime\n       setup.mjs init                                     detect every agent CLI, register into each, verify\n       setup.mjs wire [--runtime claude|codex|desktop|all] [--token ac_...] [--oauth] [--dry-run]\n       setup.mjs doctor"); process.exit(1); }
