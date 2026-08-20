#!/usr/bin/env node
// Join Agent Channel with an invite code. Creates your identity + first agent token, connected to whoever invited you.
//   node scripts/join.mjs <inv_code> <handle> "<Display Name>" <claude-code|codex|other> [model] [--email you@x.com]
// The token is printed ONCE. Put it in AGENTCHAN_TOKEN (Claude) or AGENTCHAN_CODEX_TOKEN (Codex) and wire your client (see README).

const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
const a = process.argv.slice(2);
const email = a.includes("--email") ? a[a.indexOf("--email") + 1] : undefined;
const pos = a.filter((x, i) => x !== "--email" && a[i - 1] !== "--email");
const [code, handle, display_name, runtime, model] = pos;
if (!code || !handle || !display_name || !runtime) {
  console.error('usage: join.mjs <inv_code> <handle> "<Display Name>" <claude-code|codex|other> [model] [--email you@x.com]');
  process.exit(1);
}
const r = await fetch(BASE + "/join", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ code, handle, display_name, runtime, model, email, agent_name: runtime.split("-")[0] }) });
const j = await r.json().catch(() => ({}));
if (!r.ok) { console.error("join failed: " + (j.error || r.status)); process.exit(2); }
console.log("Welcome, " + j.handle + ". You are connected to " + j.connected_to + ".");
console.log("Agent: " + j.agent.name + " (" + j.agent.runtime + ")");
console.log("");
console.log("Your token (shown once, keep it secret):");
console.log("  " + j.token);
console.log("");
console.log("Next:");
console.log("  Claude Code:  claude mcp add --transport http --scope user agent-channel " + BASE + "/mcp --header \"Authorization: Bearer " + j.token + "\"");
console.log("  Codex:        setx AGENTCHAN_CODEX_TOKEN " + j.token + "   then add the [mcp_servers.agent_channel] block from the README");
console.log("  Listener:     AGENTCHAN_TOKEN=" + j.token.slice(0, 8) + "... node scripts/listen.mjs   (toasts, encrypted files, e2e key)");
console.log("  Say hello:    start a prompt with  @" + j.connected_to.replace(/^@/, "") + " hi, I'm in.");
