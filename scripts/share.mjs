#!/usr/bin/env node
// Make a read-only link for a file or for this session's conversation. The receiver installs nothing: they open the link in a
// browser and it decrypts there. The key is generated here, put after # in the link, and never sent to the server.
//
//   node scripts/share.mjs <path> [--expires 72h|3d] [--views N] [--runtime claude|codex]
//   node scripts/share.mjs --conversation [--last N] [--full] [--expires 72h] [--views N]
//   node scripts/share.mjs --list | --revoke <id>
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve, dirname } from "node:path";
import { webcrypto as wc } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tokenFor, BASE } from "../lib/paths.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const runtime = (opt("--runtime", process.env.AGENTCHAN_RUNTIME || "claude")).replace(/-code$/, "");
let token = tokenFor(runtime);
if (!token) {
  // No invite needed to share: mint an anonymous sender token (links only) and keep it for next time. `join` replaces it.
  const { saveTok } = await import("../lib/paths.mjs");
  try {
    const r = await fetch(BASE + "/anon", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runtime }), signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.token) throw new Error(j.error || ("HTTP " + r.status));
    token = j.token;
    const f = saveTok(runtime, { token, runtime, base: BASE, handle: j.handle, anon: true });
    console.error("(no account needed: using an anonymous share token, saved to " + f + ". Links only; join with an invite to message people or send files.)");
  } catch (e) { console.error("Could not get a share token: " + e.message); process.exit(1); }
}
const H = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (path, body, method) => { const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + " -> " + r.status + " " + (j.error || "")); return j; };
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hours = (s) => { const m = String(s || "72h").match(/^(\d+)\s*([hd])?$/i); if (!m) return 72; return m[2]?.toLowerCase() === "d" ? Number(m[1]) * 24 : Number(m[1]); };

if (has("--list")) { const j = await api("/links"); for (const l of j.links) console.log((l.revoked_at ? "revoked " : new Date(l.expires_at) < new Date() ? "expired " : "active  ") + l.id + "  " + (l.filename || l.kind) + "  " + l.size + "b  views " + l.views + (l.max_views ? "/" + l.max_views : "") + "  expires " + l.expires_at); process.exit(0); }
if (has("--revoke")) { await api("/links/" + opt("--revoke") + "/revoke", {}); console.log("revoked"); process.exit(0); }

let bytes, filename, kind, contentType;
if (has("--conversation")) {
  const here = dirname(fileURLToPath(import.meta.url));
  const a = [resolve(here, "export-conversation.mjs"), "--runtime", runtime];
  if (opt("--last")) a.push("--last", opt("--last")); if (has("--full")) a.push("--full"); if (opt("--cwd")) a.push("--cwd", opt("--cwd")); if (opt("--session")) a.push("--session", opt("--session")); if (opt("--since")) a.push("--since", opt("--since"));
  const outText = execFileSync(process.execPath, a, { encoding: "utf8", env: process.env });
  const m = outText.match(/-> (.+\.(?:md|txt))\s*$/m);
  const file = opt("--out") || m?.[1];
  if (!file) { console.error("could not find the exported transcript path in export-conversation output:\n" + outText); process.exit(1); }
  bytes = readFileSync(file); filename = basename(file); kind = "conversation"; contentType = "text/markdown";
} else {
  const p = args.find((x) => !x.startsWith("--") && args[args.indexOf(x) - 1] !== "--expires" && args[args.indexOf(x) - 1] !== "--views" && args[args.indexOf(x) - 1] !== "--runtime");
  if (!p) { console.error("usage: share <path> [--expires 72h] [--views N]  |  share --conversation [--last N]  |  --list  |  --revoke <id>"); process.exit(1); }
  const st = statSync(p); if (!st.isFile()) { console.error("not a file: " + p); process.exit(1); }
  bytes = readFileSync(p); filename = basename(p); kind = "file";
  const ext = extname(p).toLowerCase();
  contentType = ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".jsonl": "application/x-ndjson", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html", ".log": "text/plain" })[ext] || "application/octet-stream";
}
if (bytes.length > 6 * 1024 * 1024) { console.error("too large (6 MB max for links; use `send @handle` for bigger files)"); process.exit(1); }

const key = await wc.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const iv = wc.getRandomValues(new Uint8Array(12));
const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
const raw = await wc.subtle.exportKey("raw", key);
const r = await api("/links", { kind, filename, content_type: contentType, size: bytes.length, iv: b64u(iv), ciphertext: b64u(ct), expires_in_hours: hours(opt("--expires")), max_views: opt("--views") ? Number(opt("--views")) : undefined });
const link = r.url + "#" + b64u(raw);
console.log(link);
console.error("(" + filename + ", " + bytes.length + " bytes, expires " + r.expires_at + (opt("--views") ? ", " + opt("--views") + " view(s)" : "") + ". The part after # is the key; the server never sees it. Revoke: agent-channel share --revoke " + r.id + ")");
