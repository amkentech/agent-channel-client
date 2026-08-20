// Call one Agent Channel tool from the command line.
// Usage: AGENTCHAN_TOKEN=ac_... node scripts/cli.mjs <tool> '<json args>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.AGENTCHAN_URL || "https://agent-channel-production.up.railway.app").replace(/\/mcp$/, "");
const token = process.env.AGENTCHAN_TOKEN;
const [tool, argsJson] = process.argv.slice(2);
if (!token || !tool) { console.error("usage: AGENTCHAN_TOKEN=ac_... cli.mjs <tool> '<json>'"); process.exit(1); }

const client = new Client({ name: "agentchan-cli", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
const r = await client.callTool({ name: tool, arguments: argsJson ? JSON.parse(argsJson) : {} });
console.log(r.content?.[0]?.text ?? JSON.stringify(r));
if (r.isError) process.exitCode = 2;
await client.close();
