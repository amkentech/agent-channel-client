// Whether Agent Channel can actually reach a running Codex session.
//
// Codex has no post-tool hook, so mid-turn delivery does not work the way it does on Claude Code. Instead the
// resident listener pushes events into a live Codex thread over the app-server WebSocket (lib/codex-push.mjs).
// That path has three links, and the last one is a human habit rather than a file:
//   1. the app-server is running            (run_codex_appserver.cmd)
//   2. the listener knows where it is       (AGENTCHAN_CODEX_WS in run_listen_codex.cmd)
//   3. the Codex TUI is ATTACHED to it      (codex-remote.cmd, i.e. codex --remote ws://...)
// Miss the third and the first two still look perfect: the server is up, the listener runs, and every push is
// dropped with "no loaded thread". On 2026-08-27 this had a 0% success rate here - 16 attempts, 16 skips, zero
// deliveries - while doctor reported Codex fully wired, because the only evidence was a line in a log nobody
// opens. Same failure as the hook's silent catches, one layer out: the mechanism existed and never once ran.
//
// So doctor reads the outcome, not the configuration. Success is the only thing that proves a delivery path.

import { connect } from "node:net";
import WebSocket from "ws";
import { selectLoadedThread } from "./codex-push.mjs";

/** Parse the push results out of the listener log. Pure: hand it the text. The listener writes one line per
 *  attempt - "codex push ok (turn, thread abc12345)" or "codex push skipped: <reason>" - and nothing else
 *  reports them. Newest reasons first by count, because one dominant reason is the whole diagnosis. */
export function summarizePushLog(text, limit = 400) {
  const lines = String(text || "").split("\n").filter((l) => l.includes("codex push "));
  const recent = lines.slice(-limit);
  let ok = 0;
  const reasons = new Map();
  for (const l of recent) {
    if (l.includes("codex push ok")) { ok += 1; continue; }
    const i = l.indexOf("codex push skipped:");
    if (i === -1) continue;
    const reason = l.slice(i + "codex push skipped:".length).trim() || "unknown";
    reasons.set(reason, (reasons.get(reason) || 0) + 1);
  }
  const skipped = [...reasons.values()].reduce((n, x) => n + x, 0);
  return {
    ok, skipped, attempts: ok + skipped,
    reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

/** The configured app-server address: what the listener launcher sets, else the env, else the documented
 *  default. Reading the launcher matters - the listener runs as a detached process and its environment is not
 *  visible from here, so the file that sets it is the only honest source. */
export function configuredWs(launcherText, env = {}) {
  const KEY = "AGENTCHAN_CODEX_WS";
  for (const raw of String(launcherText || "").split("\n")) {
    const line = raw.trim();
    const at = line.toUpperCase().indexOf(KEY);
    if (at === -1) continue;
    const eq = line.indexOf("=", at);
    if (eq === -1) continue;
    const val = line.slice(eq + 1).trim();
    if (val) return { url: val, source: "launcher" };
  }
  if (env[KEY]) return { url: env[KEY], source: "env" };
  return { url: "ws://127.0.0.1:4517", source: "default" };
}

/** host:port out of a ws:// or wss:// address, without pulling in a URL parser for two fields. */
export function wsHostPort(url) {
  let rest = String(url || "");
  for (const p of ["ws://", "wss://", "http://", "https://"]) if (rest.startsWith(p)) { rest = rest.slice(p.length); break; }
  rest = rest.split("/")[0];
  const cut = rest.lastIndexOf(":");
  if (cut === -1) return { host: rest, port: null };
  const port = Number(rest.slice(cut + 1));
  return { host: rest.slice(0, cut), port: Number.isFinite(port) ? port : null };
}

/** Is anything listening? A TCP connect, not a WebSocket handshake: doctor must never hang, and "the port is
 *  open" is exactly the fact being reported. Never throws. */
export function probe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!host || !port) return resolve({ reachable: false, reason: "no host/port" });
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(r); } };
    const s = connect({ host, port });
    s.setTimeout(timeoutMs);
    s.on("connect", () => finish({ reachable: true }));
    s.on("timeout", () => finish({ reachable: false, reason: "timeout" }));
    s.on("error", (e) => finish({ reachable: false, reason: e.code || e.message }));
  });
}

/** Ask the app-server whether it has a loaded thread available. This is read-only and stronger than an open
 *  TCP port, but does not prove an interactive TUI subscriber is still attached. Never throws. */
export function probeLoadedThread(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ loaded: false, reason: "timeout" }), timeoutMs);
    try { ws = new WebSocket(url); }
    catch (e) { return finish({ loaded: false, reason: e.message }); }
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}) => new Promise((res, rej) => {
      const requestId = ++id;
      pending.set(requestId, { res, rej });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
    });
    ws.on("error", (e) => finish({ loaded: false, reason: e.message }));
    ws.on("message", (bytes) => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (message.id === undefined || !pending.has(message.id)) return;
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error ? request.rej(new Error(JSON.stringify(message.error))) : request.res(message.result);
    });
    ws.on("open", async () => {
      try {
        await call("initialize", { clientInfo: { name: "agent-channel-doctor", title: "Agent Channel Doctor", version: "0.8.1" }, capabilities: {} });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        const loaded = await call("thread/loaded/list", {});
        const selection = selectLoadedThread(loaded);
        finish(selection.threadId ? { loaded: true, threadId: selection.threadId } : { loaded: false, reason: selection.reason });
      } catch (e) { finish({ loaded: false, reason: e.message }); }
    });
  });
}

/** The verdict doctor prints. Configuration that has never delivered is not a pass. */
export function pushVerdict({ summary, reachable, loaded = false }) {
  if (!summary.attempts) {
    return { level: "warn", text: loaded
      ? "loaded Codex thread available; the listener has not received anything to deliver yet"
      : reachable
      ? "app-server reachable, but no loaded Codex thread is available and the listener has not attempted a push yet"
      : "app-server not reachable and no push attempted - start run_codex_appserver.cmd, then Codex via codex-remote.cmd" };
  }
  if (summary.ok === 0) {
    const onlyNoLoadedThread = summary.reasons.length > 0 && summary.reasons.every((item) => item.reason.includes("no loaded thread"));
    if (loaded && onlyNoLoadedThread) return { level: "warn", text: "loaded Codex thread now available; " + summary.skipped + " earlier push(es) were skipped because no thread was loaded" };
    const top = summary.reasons[0];
    return { level: "bad", text: "mid-turn delivery to Codex has NEVER succeeded (" + summary.attempts + " attempt(s), 0 delivered). Top reason: " + (top ? top.reason : "unknown")
      + (top && top.reason.includes("no loaded thread") ? "  -> start Codex with codex-remote.cmd (codex --remote), not plain codex" : "") };
  }
  if (summary.skipped) {
    return { level: "warn", text: summary.ok + " push(es) delivered, " + summary.skipped + " skipped. Most common skip: " + summary.reasons[0].reason };
  }
  return { level: "ok", text: summary.ok + " push(es) delivered to a live Codex thread, none skipped" };
}
