#!/usr/bin/env node
// Live inbox pane: a tiny always-on view of what is arriving on Agent Channel, for a terminal split
// next to Codex or Claude Code. No model, no network: it tails the local files the resident listener
// writes (~/.agentchan/<handle>/events.jsonl + artifacts.jsonl). Works the same for every runtime.
//
//   node scripts/inbox-view.mjs [handle] [--lines 12]
//   Windows Terminal, split under the current pane:   wt -w 0 sp -H --size 0.25 node C:/Users/johna/agent-channel/scripts/inbox-view.mjs johnathan-b
//   (or run_inbox_view.cmd, which does exactly that)

import { readFileSync, existsSync, watch, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const N = Number(flag("--lines", 12));
const root = join(homedir(), ".agentchan");
let handle = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--lines");
if (!handle) {
  // most recently active handle dir
  const dirs = existsSync(root) ? readdirSync(root).filter((h) => existsSync(join(root, h, "events.jsonl"))) : [];
  dirs.sort((a, b) => statSync(join(root, b, "events.jsonl")).mtimeMs - statSync(join(root, a, "events.jsonl")).mtimeMs);
  handle = dirs[0];
}
if (!handle) { console.log("no listener data yet under " + root + " (start scripts/listen.mjs first)"); process.exit(1); }
const dir = join(root, handle);
const evF = join(dir, "events.jsonl"), arF = join(dir, "artifacts.jsonl"), pkF = join(dir, "peek.json");

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

let last = "";
function render() {
  const evs = readLines(evF).filter((e) => e.type !== "artifact");
  const files = readLines(arF).map((f) => ({ ...f, type: "_file", at: f.received_at }));
  const all = [...evs, ...files].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-N);
  let peek = null; try { peek = JSON.parse(readFileSync(pkF, "utf8")).peek; } catch {}
  const waiting = peek ? (peek.unread_messages || 0) + (peek.proposals_awaiting_you || 0) : null;
  const head = C.b + "Agent Channel " + C.x + C.dim + "@" + handle + C.x + (waiting === null ? C.dim + "  (listener not running?)" + C.x : waiting ? "  " + C.y + C.b + waiting + " waiting" + C.x : "  " + C.g + "clear" + C.x);
  const body = all.length ? all.map(fmt).join("\n") : C.dim + "  nothing yet" + C.x;
  const out = head + "\n" + body;
  if (out !== last) { last = out; process.stdout.write("\x1b[2J\x1b[H" + out + "\n"); }
}
render();
try { watch(dir, { persistent: true }, () => setTimeout(render, 150)); } catch {}
setInterval(render, 2000);
