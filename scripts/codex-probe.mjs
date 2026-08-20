// Probe the Codex app-server protocol over WebSocket: can a second client see loaded threads and inject into them?
// node scripts/codex-probe.mjs ws://127.0.0.1:4517 [threadId] [text]
import WebSocket from "ws";
const [url = "ws://127.0.0.1:4517", threadArg, textArg] = process.argv.slice(2);
const ws = new WebSocket(url);
let id = 0; const pending = new Map();
const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ jsonrpc: "2.0", id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error("timeout " + method)); } }, 15000); });
ws.on("message", (b) => {
  const m = JSON.parse(b.toString());
  if (m.id !== undefined && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  else if (m.method) console.log("<< notif", m.method, JSON.stringify(m.params || {}).slice(0, 200));
});
ws.on("open", async () => {
  try {
    const init = await call("initialize", { clientInfo: { name: "agentchan-probe", title: "Agent Channel", version: "0.0.1" }, capabilities: {} });
    console.log("initialize ok:", JSON.stringify(init).slice(0, 300));
    ws.send(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }));
    const loaded = await call("thread/loaded/list", {});
    console.log("loaded threads:", JSON.stringify(loaded).slice(0, 500));
    const list = await call("thread/list", { limit: 5 });
    console.log("thread/list:", JSON.stringify(list).slice(0, 600));
    const tid = threadArg || loaded?.data?.[0]?.id || loaded?.threads?.[0]?.id || loaded?.threadIds?.[0];
    if (tid && textArg) {
      // 1) inject into model-visible history (no turn)
      try {
        const r = await call("thread/inject_items", { threadId: tid, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "[Agent Channel] " + textArg }] }] });
        console.log("inject_items ok:", JSON.stringify(r).slice(0, 300));
      } catch (e) { console.log("inject_items failed:", e.message); }
    }
    ws.close();
  } catch (e) { console.error("probe error:", e.message); ws.close(); }
});
ws.on("error", (e) => console.error("ws error", e.message));
