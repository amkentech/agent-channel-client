#!/usr/bin/env node
// Publish an artifact (or a whole directory) at a STABLE URL. First publish prints the link; every publish after that
// with the same slug updates what the same link shows. Readers bookmark one address, once; you never resend a link
// because you revised the file. Old versions stay readable at ?v=N until they expire.
//
// One key per doc, generated here on first publish and kept in ~/.agentchan/docs.json, so the #key fragment in every
// reader's saved URL keeps decrypting new versions. The server never sees the key. The flip side: anyone who ever had
// the link can read all future versions too. To cut readers off, `--revoke` and publish under a new slug (new key).
//
//   node scripts/publish.mjs <path|dir> --as <slug> [--title "..."] [--expires 7d] [--runtime claude|codex]
//   node scripts/publish.mjs --list | --url <slug> | --touch <slug> [--expires 7d] | --revoke <slug>
import { readFileSync, statSync, readdirSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { webcrypto as wc } from "node:crypto";
import { gzipSync } from "node:zlib";
import { tarCreate } from "../lib/tar.mjs";
import { tokenFor, BASE, HOME_STORE } from "../lib/paths.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(k);
const runtime = (opt("--runtime", process.env.AGENTCHAN_RUNTIME || "claude")).replace(/-code$/, "");
const token = tokenFor(runtime);
if (!token) { console.error("No token. Docs need a real account (anonymous senders get plain `share` links only). Join: npx @amkentech/agent-channel join <invite_code> <handle> \"Your Name\""); process.exit(1); }
const H = { authorization: "Bearer " + token, "content-type": "application/json" };
const api = async (path, body, method) => { const r = await fetch(BASE + path, { method: method || (body ? "POST" : "GET"), headers: H, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + " -> " + r.status + " " + (j.error || "")); return j; };
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hours = (s) => { const m = String(s || "").match(/^(\d+)\s*([hd])?$/i); if (!m) return undefined; return m[2]?.toLowerCase() === "d" ? Number(m[1]) * 24 : Number(m[1]); };

// ~/.agentchan/docs.json: { "<slug>": { doc_id, key, url } } — the key is the doc's lifetime secret; 0600 where honoured.
const STORE = join(HOME_STORE, "docs.json");
const loadStore = () => { try { return JSON.parse(readFileSync(STORE, "utf8")); } catch { return {}; } };
const saveStore = (s) => { mkdirSync(HOME_STORE, { recursive: true }); writeFileSync(STORE, JSON.stringify(s, null, 2)); try { chmodSync(STORE, 0o600); } catch {} };

if (has("--list")) {
  const j = await api("/docs/mine");
  const store = loadStore();
  if (!j.docs.length) console.log("no docs yet. publish one: agent-channel publish <path> --as <slug>");
  for (const d of j.docs) {
    const state = d.revoked_at ? "revoked" : !d.expires_at || new Date(d.expires_at) < new Date() ? "expired" : "live   ";
    console.log(state + "  " + d.slug + "  v" + (d.version ?? 0) + "  " + (d.size ?? 0) + "b  views " + d.views + "  expires " + (d.expires_at || "-") + (store[d.slug]?.key ? "" : "  (no local key: published from another machine)"));
  }
  process.exit(0);
}
const slugOf = async (s) => {
  const store = loadStore();
  if (store[s]?.doc_id) return { store, rec: store[s] };
  const j = await api("/docs/mine"); const d = j.docs.find((x) => x.slug === s);
  if (!d) { console.error("no doc with slug '" + s + "'. See: publish --list"); process.exit(1); }
  return { store, rec: { doc_id: d.id, url: d.url } };
};
if (opt("--url")) { const { store, rec } = await slugOf(opt("--url")); console.log(rec.key ? rec.url + "#" + rec.key : rec.url + "   (key not on this machine; the full link is wherever it was first published)"); process.exit(0); }
if (opt("--touch")) {
  const { rec } = await slugOf(opt("--touch"));
  const r = await api("/docs/" + rec.doc_id + "/touch", { expires_in_hours: hours(opt("--expires")) });
  console.log("touched: v" + r.version + " now expires " + r.expires_at);
  process.exit(0);
}
if (opt("--revoke")) {
  const { store, rec } = await slugOf(opt("--revoke"));
  await api("/docs/" + rec.doc_id + "/revoke", {});
  delete store[opt("--revoke")]; saveStore(store);
  console.log("revoked: the URL and every version are dead. Republishing the same slug starts a NEW key, so hand out the new link.");
  process.exit(0);
}

const p = args.find((x, i) => !x.startsWith("--") && !["--as", "--title", "--expires", "--runtime", "--url", "--touch", "--revoke"].includes(args[i - 1]));
if (!p) { console.error("usage: publish <path|dir> --as <slug> [--title \"...\"] [--expires 7d]  |  --list  |  --url <slug>  |  --touch <slug>  |  --revoke <slug>"); process.exit(1); }
const st = statSync(p);
const slug = (opt("--as") || basename(p).replace(/\.[^.]+$/, "")).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+/, "").slice(0, 63);
if (!slug) { console.error("could not derive a slug; pass --as <slug>"); process.exit(1); }

let bytes, filename, kind, contentType;
if (st.isDirectory()) {
  const SKIP = new Set([".git", "node_modules", ".agentchan"]);
  const files = [];
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (SKIP.has(e.name)) continue; const f = join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) files.push(f); } };
  walk(p);
  if (!files.length) { console.error("empty directory"); process.exit(1); }
  bytes = Buffer.from(gzipSync(tarCreate(files.map((f) => ({ path: relative(p, f), data: readFileSync(f), mtime: statSync(f).mtimeMs })))));
  filename = slug + ".tar.gz"; kind = "bundle"; contentType = "application/gzip";
  console.error("(bundled " + files.length + " files, " + bytes.length + " bytes gzipped)");
} else {
  bytes = readFileSync(p); filename = basename(p); kind = "file";
  const ext = extname(p).toLowerCase();
  contentType = ({ ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".jsonl": "application/x-ndjson", ".csv": "text/csv", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".html": "text/html", ".log": "text/plain" })[ext] || "application/octet-stream";
}
if (bytes.length > 6 * 1024 * 1024) { console.error("too large (6 MB max per version; for a directory, prune what readers do not need)"); process.exit(1); }

const store = loadStore();
let keyB64 = store[slug]?.key;
if (!keyB64) { const key = await wc.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]); keyB64 = b64u(await wc.subtle.exportKey("raw", key)); }
const key = await wc.subtle.importKey("raw", Buffer.from(keyB64, "base64url"), { name: "AES-GCM" }, false, ["encrypt"]);
const iv = wc.getRandomValues(new Uint8Array(12));
const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);

const r = await api("/docs/publish", { slug, title: opt("--title"), kind, filename, content_type: contentType, size: bytes.length, iv: b64u(iv), ciphertext: b64u(ct), expires_in_hours: hours(opt("--expires")) });
store[slug] = { doc_id: r.doc_id, key: keyB64, url: r.url };
saveStore(store);
console.log(r.url + "#" + keyB64);
console.error("(v" + r.version + ", " + bytes.length + " bytes, expires " + r.expires_at + ". " + (r.version === 1 ? "Hand this link out once; every future `publish --as " + slug + "` updates it in place." : "Same link as before; readers now see v" + r.version + ". Nothing to resend.") + ")");
