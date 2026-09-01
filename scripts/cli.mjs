// Call one Agent Channel tool from the command line.
// Usage: node scripts/cli.mjs <tool> '<json args>' [--runtime <claude|codex|gemini|...>]
//
// The token comes from that runtime's own variable, per lib/adapters.mjs (claude -> AGENTCHAN_TOKEN, codex ->
// AGENTCHAN_CODEX_TOKEN, ...), else ~/.agentchan/tok.<runtime>.json. With no --runtime this is claude, so
// AGENTCHAN_TOKEN=ac_... node scripts/cli.mjs <tool> '<json>' keeps working exactly as before.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { tokenFor, tokenEnvFor } from "../lib/paths.mjs";

const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
// This script is the documented fallback for "the MCP is not loaded in the session", so whichever identity it
// picks is the identity a person gets when nothing else works. It read AGENTCHAN_TOKEN unconditionally, which
// on a machine wired for Claude Code made every tool call -- my_inbox, ack, return_item -- claude-code's,
// whoever asked. Having no runtime concept at all also meant `--runtime x` fell into the positional slots and
// JSON.parse choked on "--runtime".
const argv = process.argv.slice(2);
const ri = argv.indexOf("--runtime");
const runtime = (ri >= 0 ? argv[ri + 1] : process.env.AGENTCHAN_RUNTIME) || "claude";
const [tool, argsJson] = ri >= 0 ? [...argv.slice(0, ri), ...argv.slice(ri + 2)] : argv;
const token = tokenFor(runtime);
if (!tool) { console.error("usage: cli.mjs <tool> '<json>' [--runtime <claude|codex|...>]"); process.exit(1); }
if (!token) { console.error("no token for '" + runtime + "': set " + tokenEnvFor(runtime) + ", or run  node scripts/setup.mjs wire --runtime " + runtime); process.exit(1); }

const client = new Client({ name: "agentchan-cli", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
console.log(r.content?.[0]?.text ?? JSON.stringify(r));
if (r.isError) process.exitCode = 2;
await client.close();
