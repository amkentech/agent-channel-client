// Rotate this machine's agent token for one runtime: same agent (same id, label, history), new secret, new expiry.
// Usage: node scripts/rotate-token.mjs [--runtime claude|codex|...]     (agent-channel rotate-token)
//
// The server keeps the old token working for a short grace window (default 60 minutes) so a running session or the
// listener is not cut mid-turn; restart them within it. The new token is saved to ~/.agentchan/tok.<runtime>.json
// (owner-only), any existing user env var for the runtime is refreshed (Windows), and the MCP client entry this
// runtime's adapter writes is rewritten. The token itself is never printed and never placed on a command line.
import { tokenFor, readTok, saveTok, tokFileHome, BASE } from "../lib/paths.mjs";
import { adapterFor } from "../lib/adapters.mjs";

const argv = process.argv.slice(2);
const ri = argv.indexOf("--runtime");
const key = String((ri >= 0 ? argv[ri + 1] : process.env.AGENTCHAN_RUNTIME) || "claude").toLowerCase();
const ad = adapterFor(key);
const old = tokenFor(key);
if (!old) { console.error("no token for '" + key + "' (" + tokFileHome(key) + "). Nothing to rotate."); process.exit(1); }
if (!old.startsWith("ac_")) { console.error("only ac_ agent tokens rotate; OAuth clients refresh on their own."); process.exit(1); }

const r = await fetch(BASE + "/agents/rotate", { method: "POST", headers: { authorization: "Bearer " + old, "content-type": "application/json" }, body: "{}" });
let body = null; try { body = await r.json(); } catch {}
if (!r.ok || !body?.token) { console.error("rotate failed (" + r.status + "): " + (body?.error || "no token in response")); process.exit(1); }

const rec = readTok(key) || {};
saveTok(key, { ...rec, file: undefined, token: body.token, agent_id: body.id ?? rec.agent_id ?? null, runtime: body.runtime ?? rec.runtime ?? ad?.runtime, base: BASE, token_expires_at: body.token_expires_at ?? null });
let wired = "not rewired (no adapter)";
try {
  if (ad?.mcpWire) { const w = ad.mcpWire({ url: BASE, token: body.token }).apply(); wired = w.ok ? "MCP entry updated" + (w.note ? " (" + w.note + ")" : "") : "MCP entry not updated: " + w.why; }
} catch (e) { wired = "MCP entry not updated: " + e.message; }
console.log("rotated " + key + " agent " + body.id + ": new token saved to " + tokFileHome(key) + ", expires " + (body.token_expires_at || "never") +
  ". " + wired + ". The old token keeps working for " + body.previous_valid_minutes + " minutes: restart open sessions and the listener before then.");
