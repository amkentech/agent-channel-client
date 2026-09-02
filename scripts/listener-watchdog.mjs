#!/usr/bin/env node
// Keep the resident listeners alive on Windows. macOS gets LaunchAgent KeepAlive and Linux gets systemd
// Restart=always; the Windows path only ever started the listener at logon, so a listener that died mid-session
// stayed dead until someone ran doctor. Messages still arrive on the server — the hook's peek falls back to a
// live /peek — but toasts, file auto-fetch, and the local events.jsonl all stop, silently. This closes that.
//
//   node scripts/listener-watchdog.mjs [--dry-run] [--install] [--uninstall] [--status]
//
// Default run: for every wired runtime, if the listener has not touched its heartbeat/peek.json inside the
// staleness window, kill any wedged process for that runtime and start it again. Logs one line per action to
// ~/.agentchan/watchdog.log and stays silent when everything is healthy (cron noise is how logs get ignored).
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { tokenFor } from "../lib/paths.mjs";
import { ADAPTERS } from "../lib/adapters.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const H = homedir();
const WIN = platform() === "win32";
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const DRY = has("--dry-run");
const TASK = "AgentChannelListenerWatchdog";
// The usual cause of a listener process this watchdog cannot attribute: a legacy all-listeners Startup entry
// next to the per-runtime one, so every listener starts twice at logon and only one of them writes a pid
// file. wire removes the legacy entry (setup.mjs step 7); the next logon then starts each listener once.
const DUP_FIX = "run: npx @amkentech/agent-channel wire  (removes duplicate startup entries)";
// A listener refreshes its heartbeat every 30s and peek.json on every event. 6 minutes of neither means it is
// gone or wedged — long enough that a slow reconnect (backoff tops out around 60s) is never mistaken for death.
const STALE_MS = Number(process.env.AGENTCHAN_WATCHDOG_STALE_MS || 6 * 60_000);
// Which runtimes have a resident listener at all, asked of the adapters rather than written out here. The
// hardcoded ["claude", "codex"] was the other half of the token bug below: the two lists had to stay in step
// by hand, and the one that decided identity was a two-branch ternary. Today this resolves to exactly the same
// pair, so nothing changes; a third adapter with `listener: true` is now picked up instead of being silently
// skipped, and it arrives with its own token rather than Claude Code's.
const RUNTIMES = Object.values(ADAPTERS).filter((a) => a.listener).map((a) => a.key);

const logFile = join(H, ".agentchan", "watchdog.log");
function log(line) {
  const s = new Date().toISOString() + " " + line;
  console.log(s);
  try { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, s + "\n"); } catch {}
}

/** Does this runtime have an identity of its OWN? Nothing here may guess at that.
 *
 *  This decision is not passive: a runtime counted as wired but with no live listener gets one STARTED, every
 *  ten minutes, indefinitely. It used to be `existsSync(~/.agentchan/tok.<rt>.json) || process.env[rt ===
 *  "codex" ? AGENTCHAN_CODEX_TOKEN : AGENTCHAN_TOKEN]`, which is the pattern removed from listen.mjs in
 *  cd0f0ef -- a two-entry table that answers "AGENTCHAN_TOKEN" for every runtime that is not Codex, so any
 *  third listener runtime would be declared provisioned by the mere presence of Claude Code's credential and
 *  handed a listener that has no identity to run as. It also read the store's default path directly, so under
 *  AGENTCHAN_HOME -- a second identity on one machine -- it looked in the wrong directory and declared a
 *  perfectly wired runtime unwired.
 *
 *  tokenFor answers both: the adapter's declared tokenEnv, then the record in whichever store is in force. The
 *  token itself is never held, printed, or logged here; only whether one exists. */
const tokenExists = (rt) => !!tokenFor(rt);

/** Which handle owns this runtime's listener (the listener drops an owner.<runtime> marker next to its state). */
function ownerHandle(rt) {
  const root = join(H, ".agentchan");
  try { for (const h of readdirSync(root)) { try { if (readFileSync(join(root, h, "owner." + rt), "utf8").trim() === "1") return h; } catch {} } } catch {}
  return null;
}

/** Newest mtime across the listener's liveness files, or 0 if it has never written any. */
function lastBeat(handle) {
  let newest = 0;
  for (const f of ["heartbeat", "peek.json", "events.jsonl"]) {
    try { newest = Math.max(newest, statSync(join(H, ".agentchan", handle, f)).mtimeMs); } catch {}
  }
  return newest;
}

/** Every live node PID running listen.mjs, regardless of runtime. */
function allListenerPids() {
  if (!WIN) return [];
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*listen.mjs*' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 });
    if (!out.trim()) return [];
    const v = JSON.parse(out.trim());
    return (Array.isArray(v) ? v : [v]).map(Number).filter(Boolean);
  } catch { return []; }
}

/**
 * PIDs of the listener for THIS runtime. Both launchers invoke the identical command line
 * (`node scripts\listen.mjs`, differing only by environment), so the process list cannot tell them apart —
 * the listener writes its own pid file on connect and that is the authority. The command-line scan is only a
 * fallback for a listener started before pid files existed, and then only when exactly one process is running.
 */
function listenerPids(rt) {
  if (!WIN) return [];
  const live = new Set(allListenerPids());
  try {
    const rec = JSON.parse(readFileSync(join(H, ".agentchan", "listener." + rt + ".pid"), "utf8"));
    if (rec.pid && live.has(Number(rec.pid))) return [Number(rec.pid)];
    return [];                                   // pid file exists but that process is gone: nothing to kill
  } catch {}
  const others = RUNTIMES.filter((r) => r !== rt).map((r) => { try { return Number(JSON.parse(readFileSync(join(H, ".agentchan", "listener." + r + ".pid"), "utf8")).pid); } catch { return 0; } }).filter(Boolean);
  const unclaimed = [...live].filter((p) => !others.includes(p));
  return unclaimed.length === 1 ? unclaimed : []; // ambiguous: never kill a process we cannot attribute
}

function killPids(pids) {
  for (const pid of pids) {
    try { execFileSync("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore", timeout: 20000 }); log("  killed wedged pid " + pid); }
    catch (e) { log("  could not kill pid " + pid + ": " + String(e.message).slice(0, 80)); }
  }
}

function startListener(rt) {
  const startup = join(process.env.APPDATA || join(H, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  const vbs = join(startup, "agent-channel-" + rt + ".vbs");
  const cmd = join(ROOT, "run_listen_" + rt + ".cmd");
  try {
    if (existsSync(vbs)) { spawn("wscript", [vbs], { detached: true, stdio: "ignore", windowsHide: true }).unref(); return "via " + vbs; }
    if (existsSync(cmd)) { spawn("cmd", ["/c", cmd], { detached: true, stdio: "ignore", windowsHide: true }).unref(); return "via " + cmd; }
    spawn(process.execPath, [join(ROOT, "scripts", "listen.mjs"), "--runtime", rt], { detached: true, stdio: "ignore", windowsHide: true, cwd: ROOT }).unref();
    return "via node directly";
  } catch (e) { return "FAILED: " + e.message; }
}

// ---------------- install / uninstall / status ----------------
// schtasks, not New-ScheduledTaskTrigger: the PowerShell cmdlet silently defaults a repetition to a 1-day
// duration, so a "every 10 minutes forever" trigger quietly stops after a day.
function install() {
  const wrapper = join(ROOT, "run_listener_watchdog.cmd");
  // the wrapper keeps the task definition to one quoted path, and sends its own output to the same log
  // ROOT is wherever this script runs from: the git checkout, or ~/.agentchan/client when setup installed the
  // package from npx (setup.mjs re-runs from that copy, so `wire` registers the task against it). Quoted: a
  // home directory with a space in it ("C:\Users\Jo Smith\.agentchan\client") breaks an unquoted cd.
  const body = "@echo off\r\ncd /d \"" + ROOT + "\"\r\nnode scripts\\listener-watchdog.mjs >> \"%USERPROFILE%\\.agentchan\\watchdog.log\" 2>&1\r\n";
  if (DRY) { log("would write " + wrapper + " and register scheduled task " + TASK + " every 10 min"); return; }
  writeFileSync(wrapper, body);
  const a = ["/Create", "/TN", TASK, "/TR", '"' + wrapper + '"', "/SC", "MINUTE", "/MO", "10", "/F"];
  try { execFileSync("schtasks", a, { stdio: "pipe", encoding: "utf8" }); log("installed scheduled task " + TASK + " (every 10 minutes) -> " + wrapper); }
  catch (e) { log("could not register the task: " + String(e.stderr || e.message).slice(0, 200)); process.exitCode = 1; }
}

function uninstall() {
  try { execFileSync("schtasks", ["/Delete", "/TN", TASK, "/F"], { stdio: "pipe", encoding: "utf8" }); log("removed scheduled task " + TASK); }
  catch (e) { log("could not remove the task (maybe not installed): " + String(e.stderr || e.message).slice(0, 160)); }
}
function status() {
  try {
    const out = execFileSync("schtasks", ["/Query", "/TN", TASK, "/FO", "LIST"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    console.log(out.trim());
  } catch { console.log("scheduled task " + TASK + " is NOT installed (run with --install)"); }
  for (const rt of RUNTIMES) {
    if (!tokenExists(rt)) { console.log(rt + ": no token, not wired"); continue; }
    const h = ownerHandle(rt);
    if (!h) { console.log(rt + ": listener has never connected (no owner marker)"); continue; }
    const age = Date.now() - lastBeat(h);
    console.log(rt + ": @" + h + " last beat " + Math.round(age / 1000) + "s ago" + (age > STALE_MS ? "  STALE" : "  ok") + ", pids " + (listenerPids(rt).join(",") || "none"));
  }
  const claimed = RUNTIMES.map((r) => { try { return Number(JSON.parse(readFileSync(join(H, ".agentchan", "listener." + r + ".pid"), "utf8")).pid); } catch { return 0; } }).filter(Boolean);
  const unattributable = allListenerPids().filter((p) => !claimed.includes(p));
  if (unattributable.length) console.log(unattributable.length + " listener process(es) cannot be attributed to a runtime (pid " + unattributable.join(",") + "); the watchdog will not restart anything while they exist. " + DUP_FIX);
}

// ---------------- the check ----------------
// Stale files alone are NEVER enough to act on. Listeners built before the heartbeat existed only touch their
// files when an event arrives, so a quiet-but-healthy old listener looks dead — acting on that signal alone
// would restart it every cycle and pile up duplicates. So: restart only when the files are stale AND no live
// listener process can be attributed to this runtime. When processes exist that cannot be attributed (an old
// listener with no pid file), say so once and do nothing; the next natural restart writes a pid file and the
// ambiguity disappears for good.
function check() {
  let acted = 0;
  const liveTotal = allListenerPids().length;
  for (const rt of RUNTIMES) {
    if (!tokenExists(rt)) continue;
    const h = ownerHandle(rt);
    if (!h) {
      if (liveTotal) { log(rt + ": no owner marker, but " + liveTotal + " listener process(es) are running — leaving them alone"); continue; }
      log(rt + ": no owner marker and no listener process — starting it");
      if (!DRY) { acted++; log("  started " + startListener(rt)); }
      continue;
    }
    const age = Date.now() - lastBeat(h);
    if (age <= STALE_MS) continue;                    // healthy: stay silent
    const mine = listenerPids(rt);
    if (mine.length) {                                // attributable and alive, but not writing: wedged
      log(rt + " (@" + h + "): wedged — pid " + mine.join(",") + " alive but silent for " + Math.round(age / 1000) + "s");
      if (DRY) { log("  would kill and restart"); continue; }
      killPids(mine);
      log("  restarted " + startListener(rt));
      acted++;
      continue;
    }
    const claimed = RUNTIMES.map((r) => { try { return Number(JSON.parse(readFileSync(join(H, ".agentchan", "listener." + r + ".pid"), "utf8")).pid); } catch { return 0; } }).filter(Boolean);
    const unattributable = allListenerPids().filter((p) => !claimed.includes(p)).length;
    if (unattributable) {                             // an older listener with no pid file is probably this one
      log(rt + " (@" + h + "): files stale " + Math.round(age / 1000) + "s but " + unattributable + " unattributable listener process(es) running — not touching it. " + DUP_FIX);
      continue;
    }
    log(rt + " (@" + h + "): dead — no process and no activity for " + Math.round(age / 1000) + "s");
    if (DRY) { log("  would start it"); continue; }
    log("  started " + startListener(rt));
    acted++;
  }
  return acted;
}

if (!WIN && !has("--status")) { console.error("This watchdog is for Windows. macOS uses the LaunchAgent's KeepAlive and Linux uses systemd Restart=always; both already restart a dead listener."); process.exit(1); }
if (has("--install")) install();
else if (has("--uninstall")) uninstall();
else if (has("--status")) status();
else check();
