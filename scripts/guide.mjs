#!/usr/bin/env node
// The guide in the terminal: fetched from the server so it never drifts from what the web pages and the MCP `guide`
// tool serve. No account needed; the guide is public.
//
//   node scripts/guide.mjs            # index of topics
//   node scripts/guide.mjs publish    # one walkthrough
import { BASE } from "../lib/paths.mjs";

const topic = process.argv.slice(2).find((a) => !a.startsWith("--"));
const url = BASE + "/guide" + (topic ? "/" + encodeURIComponent(topic.toLowerCase()) : "") + "?format=md";
try {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const body = await r.text();
  if (!r.ok) { console.error(body.trim() || "HTTP " + r.status); process.exit(1); }
  console.log(body.trim());
  if (!topic) console.error("\n(agent-channel guide <topic> for one of these; also on the web at " + BASE + "/guide)");
} catch (e) { console.error("Could not reach " + BASE + ": " + e.message); process.exit(1); }
