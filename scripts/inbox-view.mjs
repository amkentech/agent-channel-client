#!/usr/bin/env node
// Live inbox pane: a tiny always-on view of what is arriving on Agent Channel, for a terminal split
// next to Codex or Claude Code. Tails the local files the resident listener writes
// (~/.agentchan/<handle>/events.jsonl + artifacts.jsonl). Receive-only unless --runtime <key> is
// passed: then stdin accepts `@handle text` and POSTs /say as that runtime. Token is tokenFor of
// the explicit key only — never ambient AGENTCHAN_TOKEN, never AGENTCHAN_RUNTIME, never
// most-recently-active handle. No model.
//
//   node scripts/inbox-view.mjs [handle] [--lines 12]
//   node scripts/inbox-view.mjs --runtime grok [handle] [--lines 12]
//   Windows Terminal, split under the current pane:   wt -w 0 sp -H --size 0.25 node C:/Users/johna/agent-channel/scripts/inbox-view.mjs johnathan-b
//   (or run_inbox_view.cmd, which does exactly that)

import { readFileSync, existsSync, watch, readdirSync, statSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { adapterFor } from "../lib/adapters.mjs";
import { tokenFor, tokenEnvFor, fileTokenFor, readTok } from "../lib/paths.mjs";

const SEND_RE = /^\s*@([a-z0-9][a-z0-9_-]{2,31})(?=$|[ \t\r\n,:;!?])[ \t,:;]*([\s\S]*)$/i;
const SEND_USAGE = "type @handle message  (example: @sam hello)";

export function isEntryPoint(argv1 = process.argv[1], metaUrl = import.meta.url) {
  if (!argv1) return false;
  try {
    return normalize(resolve(argv1)).toLowerCase() === normalize(fileURLToPath(metaUrl)).toLowerCase();
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const args = [...argv];
  let runtime = null;
  let sawRuntime = false;
  let lines = 12;
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--runtime") {
      sawRuntime = true;
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) { runtime = String(next); i++; }
      else runtime = "";
      continue;
    }
    if (a === "--lines") {
      const next = args[i + 1];
      if (next !== undefined && !String(next).startsWith("--")) {
        const n = Number(next);
        i++;
        if (Number.isFinite(n) && n > 0) lines = n;
      }
      continue;
    }
    if (String(a).startsWith("--")) continue;
    positionals.push(a);
  }
  return {
    runtime: sawRuntime ? String(runtime || "").toLowerCase() : null,
    lines,
    handle: positionals[0] || null,
  };
}

export function parseSendLine(line) {
  if (typeof line !== "string") return { kind: "invalid" };
  if (!String(line).trim()) return { kind: "empty" };
  const m = line.match(SEND_RE);
  if (!m) return { kind: "invalid" };
  const to = m[1].toLowerCase();
  const text = m[2].trim();
  if (!text) return { kind: "invalid" };
  return { kind: "send", to, text };
}

export function resolveRuntime(name) {
  if (name == null) return null;
  const raw = String(name).trim().toLowerCase();
  if (!raw) return null;
  const adapter = adapterFor(raw);
  if (!adapter || adapter.key === "generic") return null;
  return adapter;
}

export function mostRecentHandle(root) {
  const dirs = existsSync(root) ? readdirSync(root).filter((h) => existsSync(join(root, h, "events.jsonl"))) : [];
  dirs.sort((a, b) => statSync(join(root, b, "events.jsonl")).mtimeMs - statSync(join(root, a, "events.jsonl")).mtimeMs);
  return dirs[0] || null;
}

export function resolveWatchHandle({ sendMode, positionalHandle, tokHandle, root }) {
  if (positionalHandle) return positionalHandle;
  if (sendMode) return tokHandle || null;
  return mostRecentHandle(root);
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const N = parsed.lines;
  const sendMode = parsed.runtime !== null;
  const adapter = sendMode ? resolveRuntime(parsed.runtime) : null;
  if (sendMode && !adapter) {
    console.error("unknown --runtime '" + parsed.runtime + "': not a known adapter");
    process.exit(1);
  }

  let token = null;
  const headers = { "content-type": "application/json" };
  if (sendMode) {
    token = tokenFor(adapter.key);
    if (!token) {
      console.error("no token for '" + adapter.key + "': set " + tokenEnvFor(adapter.key) + ", or run  node scripts/setup.mjs wire --runtime " + adapter.key);
      process.exit(1);
    }
    headers.authorization = "Bearer " + token;
  }

  // listen.mjs writes ~/.agentchan/<handle>/events.jsonl via homedir(), not HOME_STORE.
  // Watching HOME_STORE would miss live events when the token store is relocated.
  const root = join(homedir(), ".agentchan");
  const tokHandle = sendMode ? String(readTok(adapter.key)?.handle || "").replace(/^@/, "") || null : null;
  const handle = resolveWatchHandle({
    sendMode,
    positionalHandle: parsed.handle,
    tokHandle,
    root,
  });
  if (!handle) {
    if (sendMode) {
      console.error("send mode needs a handle: pass one as an argument, or it is read from tok." + adapter.key + ".json");
      process.exit(1);
    }
    console.log("no listener data yet under " + root + " (start scripts/listen.mjs first)");
    process.exit(1);
  }
  const dir = join(root, handle);
  const evF = join(dir, "events.jsonl"), arF = join(dir, "artifacts.jsonl"), pkF = join(dir, "peek.json");
  const url = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");

  const C = { dim: "\x1b[2m", b: "\x1b[1m", g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", c: "\x1b[36m", m: "\x1b[35m", x: "\x1b[0m" };
  const t = (iso) => { try { const d = new Date(iso); return d.toTimeString().slice(0, 8); } catch { return "??:??:??"; } };
  const readLines = (f) => existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];

  function fmt(ev) {
    const at = C.dim + t(ev.at || ev.received_at) + C.x + " ";
    switch (ev.type) {
      case "human": return at + C.b + C.g + ev.from + C.x + (ev.via === "agent" ? C.dim + " (via agent)" + C.x : "") + ": " + (ev.text || ev.summary || "");
      case "artifact": return at + C.c + "file " + C.x + "from " + ev.from + ": " + ev.filename + C.dim + " (" + ev.size_bytes + " b)" + C.x + (ev.note ? " " + ev.note : "");
      case "proposal": return at + C.y + "proposal " + C.x + "from " + ev.from + ": " + ev.summary;
      case "blocked": return at + C.r + C.b + "NEEDS YOU " + C.x + "from " + ev.from + ": " + ev.summary;
      case "connect": return at + C.m + "connect " + C.x + "from " + ev.from + ": " + ev.summary;
      case "response": case "return": case "checks": case "note": return at + C.dim + ev.type + " from " + ev.from + ": " + (ev.summary || "") + C.x;
      case "_file": {
        const v = ev.verdict === "danger" ? C.r + C.b + "QUARANTINED" + C.x : ev.verdict === "warn" ? C.y + "file (" + ev.findings.length + " warn)" + C.x : C.c + "file" + C.x;
        return at + v + " from " + ev.from + ": " + ev.filename + C.dim + " -> " + ev.path + C.x;
      }
      default: return at + ev.type + " from " + ev.from + ": " + (ev.summary || "");
    }
  }

  let sendStatus = "";
  let rl = null;
  let last = "";
  function render() {
    const evs = readLines(evF).filter((e) => e.type !== "artifact");
    const files = readLines(arF).map((f) => ({ ...f, type: "_file", at: f.received_at }));
    const all = [...evs, ...files].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-N);
    // peek.json is per-PERSON but written by whichever runtime fetched last, and /peek is runtime-scoped
    // (2026-08-27): the count in it is ONE runtime's view, not the person's total. This pane has no runtime
    // identity of its own, so it cannot distrust a mismatched stamp the way the hooks do - instead it says
    // whose view it is showing, and lists the mail addressed to a sibling runtime that the count leaves out,
    // so a handoff waiting for another CLI is visible here rather than silently absent.
    let wrap = null; try { wrap = JSON.parse(readFileSync(pkF, "utf8")); } catch {}
    const peek = wrap?.peek || null;
    const asOf = typeof wrap?.runtime === "string" ? wrap.runtime : null;
    const elsewhere = Array.isArray(peek?.handoffs_for_other_runtimes) ? peek.handoffs_for_other_runtimes : [];
    const waiting = peek ? (peek.unread_messages || 0) + (peek.proposals_awaiting_you || 0) : null;
    const view = peek ? C.dim + "  as of " + (asOf ? asOf + "'s" : "an unstamped") + " last fetch" + C.x : "";
    const bound = sendMode ? "  " + C.c + adapter.key + C.x : "";
    const head = C.b + "Agent Channel " + C.x + C.dim + "@" + handle + C.x + bound + (waiting === null ? C.dim + "  (listener not running?)" + C.x : waiting ? "  " + C.y + C.b + waiting + " waiting" + C.x : "  " + C.g + "clear" + C.x) + view;
    const other = elsewhere.map((h) => C.dim + "  ⇄ for " + (h.for_runtime || "?") + (h.from_runtime ? " from " + h.from_runtime : "") + ": " + (h.preview || "") + C.x);
    const body = all.length ? all.map(fmt).join("\n") : C.dim + "  nothing yet" + C.x;
    let status = "";
    if (sendMode) {
      if (sendStatus.startsWith("sent ")) status = C.g + sendStatus + C.x;
      else if (sendStatus.startsWith("NOT sent")) status = C.r + sendStatus + C.x;
      else if (sendStatus === "sending") status = C.dim + sendStatus + C.x;
      else if (sendStatus) status = C.y + sendStatus + C.x;
    }
    const out = [head, body, ...other, status].filter((s) => s !== "").join("\n");
    if (out !== last) {
      last = out;
      process.stdout.write("\x1b[2J\x1b[H" + out + "\n");
      if (rl) rl.prompt();
    }
  }

  let healTried = false;
  const healToken = async () => {
    if (healTried) return false;
    healTried = true;
    const envTok = process.env[tokenEnvFor(adapter.key)];
    const fileTok = fileTokenFor(adapter.key);
    if (!envTok || !fileTok || envTok === fileTok || token !== envTok) return false;
    token = fileTok;
    headers.authorization = "Bearer " + fileTok;
    return true;
  };

  async function postSay(to, text) {
    const body = JSON.stringify({ to: "@" + to, text });
    try {
      let r = await fetch(url + "/say", { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
      let j = await r.json().catch(() => ({}));
      if ((r.status === 401 || r.status === 403) && await healToken()) {
        r = await fetch(url + "/say", { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
        j = await r.json().catch(() => ({}));
      }
      if (r.ok) return { ok: true };
      const err = (typeof j.error === "string" && j.error) ? j.error : ("HTTP " + r.status);
      return { ok: false, error: err };
    } catch (e) {
      return { ok: false, error: e.message || "request failed" };
    }
  }

  render();
  try { watch(dir, { persistent: true }, () => setTimeout(render, 150)); } catch {}
  setInterval(render, 2000);

  if (!sendMode) return;

  rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("> ");
  rl.prompt();
  rl.on("line", async (line) => {
    const got = parseSendLine(line);
    if (got.kind === "empty") { rl.prompt(); return; }
    if (got.kind !== "send") {
      sendStatus = SEND_USAGE;
      last = "";
      render();
      return;
    }
    sendStatus = "sending";
    last = "";
    render();
    const r = await postSay(got.to, got.text);
    sendStatus = r.ok ? "sent to @" + got.to : "NOT sent: " + r.error;
    last = "";
    render();
  });
}

if (isEntryPoint()) await main();
