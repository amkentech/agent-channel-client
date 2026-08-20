// Push an Agent Channel event INTO a live Codex TUI thread, via the Codex app-server protocol.
// Requires: `codex app-server --listen ws://127.0.0.1:4517` running (run_codex_appserver.cmd) and the TUI
// started with `codex --remote ws://127.0.0.1:4517` so its thread is loaded on that server.
//
// mode "inject": thread/inject_items — appended to the model-visible history, no turn, no cost; the model
//                sees it on the human's next prompt (may not render in the TUI).
// mode "turn":   turn/start — a real user turn carrying the message; renders in the TUI immediately and the
//                model relays it in one line. Costs one (short) model turn. Use when the human wants to SEE it.
import WebSocket from "ws";

export async function pushToCodex({ url = process.env.AGENTCHAN_CODEX_WS || "ws://127.0.0.1:4517", text, mode = "turn", timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(r); } };
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params })); });
    const t = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    ws.on("error", (e) => { clearTimeout(t); finish({ ok: false, reason: e.message }); });
    ws.on("message", (b) => {
      let m; try { m = JSON.parse(b.toString()); } catch { return; }
      if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    });
    ws.on("open", async () => {
      try {
        await call("initialize", { clientInfo: { name: "agent-channel", title: "Agent Channel", version: "0.2.0" }, capabilities: {} });
        ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
        const loaded = await call("thread/loaded/list", {});
        const threads = loaded?.data || [];
        if (!threads.length) { clearTimeout(t); return finish({ ok: false, reason: "no loaded thread (start Codex with --remote " + url + ")" }); }
        // most recently active loaded thread
        threads.sort((a, b) => (b.recencyAt || b.updatedAt || 0) - (a.recencyAt || a.updatedAt || 0));
        const tid = threads[0].id;
        if (mode === "inject") {
          await call("thread/inject_items", { threadId: tid, items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }] });
          clearTimeout(t); return finish({ ok: true, mode, threadId: tid });
        }
        const turn = await call("turn/start", { threadId: tid, input: [{ type: "text", text }] });
        clearTimeout(t); return finish({ ok: true, mode, threadId: tid, turnId: turn?.turn?.id || turn?.turnId || null });
      } catch (e) { clearTimeout(t); finish({ ok: false, reason: e.message }); }
    });
  });
}
