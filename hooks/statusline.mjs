#!/usr/bin/env node
// Claude Code status line: a persistent, on-screen line showing what is waiting on Agent Channel.
// Reads only local files kept by the resident listener (no network), so it is instant and free.
//   settings.json:  "statusLine": { "type": "command", "command": "node C:/Users/johna/agent-channel/hooks/statusline.mjs claude" }
// Shows: unread human messages (with the latest text), files received, proposals awaiting you, human-only items.
// Empty when nothing is waiting, so the line still shows the model/cwd summary Claude Code passes in.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const runtime = (process.argv[2] || "claude").toLowerCase();
const root = join(homedir(), ".agentchan");
let input = {};
try {
  const raw = await new Promise((res) => {
    if (process.stdin.isTTY) return res("");
    const c = []; let done = false;
    const fin = () => { if (!done) { done = true; res(Buffer.concat(c).toString("utf8")); } };
    process.stdin.on("data", (d) => c.push(d)); process.stdin.on("end", fin); process.stdin.on("error", fin);
    setTimeout(fin, 300).unref();
  });
  if (raw) input = JSON.parse(raw);
} catch {}

let handle = null;
try { for (const h of readdirSync(root)) { try { if (readFileSync(join(root, h, "owner." + runtime), "utf8") === "1") handle = h; } catch {} } } catch {}

const base = (input.model?.display_name ? input.model.display_name : "") + (input.workspace?.current_dir ? "  " + input.workspace.current_dir.replace(/\\/g, "/").split("/").slice(-1)[0] : "");
if (!handle) { console.log(base); process.exit(0); }

let peek = null;
try { peek = JSON.parse(readFileSync(join(root, handle, "peek.json"), "utf8")).peek; } catch {}
const items = peek?.items || [];
const humans = items.filter((i) => i.type === "human");
const humanOnly = items.filter((i) => i.human_only && i.type !== "human");
const props = peek?.proposals_awaiting_you || 0;

// files fetched by the listener but not yet surfaced (same seen-file the hook uses)
let files = 0, lastFile = null;
try {
  const seenF = join(root, handle, "artifacts.seen");
  const seen = new Set(existsSync(seenF) ? readFileSync(seenF, "utf8").split("\n").filter(Boolean) : []);
  for (const l of readFileSync(join(root, handle, "artifacts.jsonl"), "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(l); if (!seen.has(r.id)) { files++; lastFile = r; } } catch {}
  }
} catch {}

const parts = [];
if (humans.length) {
  const last = humans[humans.length - 1];
  const t = String(last.text || "").replace(/\s+/g, " ");
  parts.push("\u2709 " + humans.length + " msg" + (humans.length > 1 ? "s" : "") + " | " + last.from + ": " + (t.length > 60 ? t.slice(0, 60) + "..." : t));
}
if (files) parts.push("\u{1F4CE} " + files + " file" + (files > 1 ? "s" : "") + (lastFile ? " (" + lastFile.from + ": " + lastFile.filename + (lastFile.verdict !== "clean" ? ", " + lastFile.verdict.toUpperCase() : "") + ")" : ""));
if (props) parts.push("\u{1F4CB} " + props + " proposal" + (props > 1 ? "s" : "") + " for you");
if (humanOnly.length) parts.push("\u26A0 " + humanOnly.length + " needs YOU (human-only)");
const online = peek ? "" : " (listener?)";

console.log(parts.length ? "[Agent Channel @" + handle + "] " + parts.join("  \u2502  ") : base + "  [Agent Channel @" + handle + ": clear" + online + "]");
