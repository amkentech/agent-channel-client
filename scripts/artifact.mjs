#!/usr/bin/env node
// End-to-end encrypted artifact exchange. The server only ever sees ciphertext + an envelope.
//
//   node scripts/artifact.mjs send @handle <path> [--note "why"]     encrypt to every key @handle has registered, upload
//   node scripts/artifact.mjs fetch <artifact_id>                    download, decrypt with a local key, inspect, save to ~/.agentchan/<me>/inbox/
//   node scripts/artifact.mjs fetch --all                            fetch everything waiting for me
//   node scripts/artifact.mjs keygen [--label name]                  create + register a key for this token (listener does this automatically)
//   node scripts/artifact.mjs rotate [--label name]                  new key registered, old key revoked, old private key kept locally (retired)
//   node scripts/artifact.mjs revoke-key <key_id> | --all            revoke a key (lost device: run from any OTHER machine of yours)
//   node scripts/artifact.mjs keys [@handle]                         list registered public keys
//
// Token: AGENTCHAN_TOKEN (or --runtime codex -> AGENTCHAN_CODEX_TOKEN). URL: AGENTCHAN_URL.

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { encryptFor, ensureKey, sha256hex, generateKeypair, findLocalKey, saveLocalKey, decryptWith, loadLocalKeys } from "../lib/crypto.mjs";
import { fetchArtifact } from "../lib/artifacts.mjs";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const runtime = (flag("--runtime") || process.env.AGENTCHAN_RUNTIME || "claude").toLowerCase();
const BASE = (process.env.AGENTCHAN_URL || "https://channel.amkentech.com").replace(/\/mcp$/, "");
let token = process.env.AGENTCHAN_TOKEN;
if (runtime === "codex" && process.env.AGENTCHAN_CODEX_TOKEN) token = process.env.AGENTCHAN_CODEX_TOKEN;
if (!token) { const { tokenFor } = await import("../lib/paths.mjs"); token = tokenFor(runtime); }
if (!token) { console.error("AGENTCHAN_TOKEN required"); process.exit(1); }
const H = { authorization: "Bearer " + token, "content-type": "application/json" };

const api = async (path, init = {}) => {
  const r = await fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + (j.error || JSON.stringify(j)));
  return j;
};

async function myHandle() {
  // /feed carries all agents; find ours by matching token is impossible, so use the MCP-free route: /keys/<x> requires handle. Use /status? No.
  // Simplest: the server tells us in the WebSocket hello, but here we do one MCP whoami call.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const c = new Client({ name: "artifact", version: "0.0.1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
  const r = await c.callTool({ name: "whoami", arguments: {} });
  await c.close();
  const j = JSON.parse(r.content[0].text);
  return { handle: j.person.handle, agent: j.agent.name, runtime: j.agent.runtime };
}

const cmd = args[0];
// ---- key pins: ~/.agentchan/pins/<handle>.json  [{id, public_key, label, runtime, first_seen}] ----
const pinDir = join(homedir(), ".agentchan", "pins");
const pinFile = (h) => join(pinDir, String(h).replace(/^@/, "").toLowerCase() + ".json");
const fp = (pub) => createHash("sha256").update(String(pub)).digest("hex").match(/.{4}/g).slice(0, 8).join(" ");
function checkPins(to, keys) {
  let pinned = []; try { pinned = JSON.parse(readFileSync(pinFile(to), "utf8")); } catch {}
  const fresh = keys.filter((k) => !pinned.some((p) => p.id === k.id || p.public_key === k.public_key));
  return { pinned, fresh };
}
function savePins(to, keys) {
  let cur = []; try { cur = JSON.parse(readFileSync(pinFile(to), "utf8")); } catch {}
  const now = new Date().toISOString();
  for (const k of keys) if (!cur.some((p) => p.id === k.id || p.public_key === k.public_key)) cur.push({ id: k.id, public_key: k.public_key, label: k.label, runtime: k.runtime, fingerprint: fp(k.public_key), first_seen: now });
  mkdirSync(pinDir, { recursive: true }); writeFileSync(pinFile(to), JSON.stringify(cur, null, 2));
}

try {
  if (cmd === "send") {
    const to = args[1], path = args[2];
    if (!to || !path) throw new Error("usage: artifact.mjs send @handle <path> [--note text]");
    const abs = resolve(path);
    const st = statSync(abs);
    if (st.size > 8 * 1024 * 1024) throw new Error("file is " + st.size + " bytes; 8 MB max");
    const bytes = readFileSync(abs);
    const { keys } = await api("/keys/" + to.replace(/^@/, ""));
    if (!keys.length) throw new Error(to + " has no registered keys yet (their listener registers one on first connect). Ask them to run: node scripts/artifact.mjs keygen");
    // Key pinning (trust on first use). The server hands out the recipient's public keys; a malicious operator could add one
    // and read everything encrypted from then on. So remember the keys we have seen per handle, and refuse to encrypt to a
    // NEW key until the human says so (--trust-new-keys), after comparing fingerprints with the other person out of band.
    const { pinned, fresh } = checkPins(to, keys);
    if (fresh.length && pinned.length && !has("--trust-new-keys")) {
      console.error("REFUSED: " + to + " has " + fresh.length + " key(s) you have never encrypted to before:\n" + fresh.map((k) => "  " + fp(k.public_key) + "  " + (k.label || "") + " (" + (k.runtime || "?") + ")").join("\n") +
        "\nAsk " + to + " to confirm these fingerprints (they run: node scripts/artifact.mjs keys), then re-run with --trust-new-keys. Or --only-pinned to encrypt to the known keys only.");
      process.exit(3);
    }
    const useKeys = has("--only-pinned") && pinned.length ? keys.filter((k) => pinned.some((p) => p.id === k.id)) : keys;
    if (!pinned.length) {
      console.error("first send to " + to + ": " + keys.length + " key(s) the server reports for them:\n" + keys.map((k) => "  " + fp(k.public_key) + "  " + (k.label || "") + " (" + (k.runtime || "?") + ")").join("\n") + "\nThese get pinned; later changes are refused until you pass --trust-new-keys. If this file matters, confirm the fingerprints with " + to + " out of band (they run: node scripts/artifact.mjs keys).");
      if (process.stdin.isTTY && !has("--trust-new-keys") && !has("--yes")) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        const ans = (await rl.question("Encrypt to these keys and pin them? [y/N] ")).trim().toLowerCase(); rl.close();
        if (ans !== "y" && ans !== "yes") { console.error("not sent."); process.exit(3); }
      }
    }
    else if (fresh.length) console.error("trusting " + fresh.length + " new key(s) for " + to + " as instructed: " + fresh.map((k) => fp(k.public_key)).join(", "));
    savePins(to, useKeys);
    const { envelope, ciphertext } = encryptFor(useKeys, bytes);
    const r = await api("/artifacts", { method: "POST", body: JSON.stringify({ to, filename: basename(abs), size_bytes: st.size, sha256: sha256hex(bytes), note: flag("--note"), envelope, ciphertext }) });
    console.log("sent " + basename(abs) + " (" + st.size + " bytes) to " + r.to + ", encrypted to " + keys.length + " key(s), artifact " + r.artifact_id + ", expires " + r.expires_at);
  } else if (cmd === "fetch") {
    const me = await myHandle();
    if (has("--all") || !args[1]) {
      const list = await api("/artifacts");
      if (!list.artifacts.length) console.log("nothing waiting");
      for (const a of list.artifacts) await fetchArtifact({ base: BASE, token, handle: me.handle, id: a.id });
    } else {
      await fetchArtifact({ base: BASE, token, handle: me.handle, id: args[1] });
    }
  } else if (cmd === "org-keygen") {
    // Enterprise custody: the ORG key is generated here, on the claimant's machine, and only the PUBLIC half is ever
    // registered (set_org_escrow). key_id is deterministic from the domain so envelopes and this key store agree.
    const me = await myHandle();
    const domain = (flag("--domain") || "").toLowerCase();
    if (!domain) { console.error("usage: artifact.mjs org-keygen --domain <your-verified-org-domain>"); process.exit(1); }
    const label = "org-escrow-" + domain;
    if (findLocalKey(me.handle, label) && !has("--force")) { console.error("an org key for " + domain + " already exists locally (" + label + "). --force replaces it; the old one stays on disk renamed only if you rename it yourself."); process.exit(1); }
    const k = generateKeypair();
    saveLocalKey(me.handle, label, { key_id: label, ...k });
    console.log("org escrow keypair for " + domain + " generated. Private key stays in ~/.agentchan/" + me.handle + "/keys/ (0600). BACK IT UP: without it, escrowed files are unreadable to the org.");
    console.log("register the public half (your agent runs set_org_escrow):\n  public_key: " + k.public_key);
  } else if (cmd === "org-list") {
    const r = await api("/org/artifacts");
    if (!r.artifacts.length) { console.log("no live artifacts among " + r.org + " members"); }
    for (const a of r.artifacts) console.log(a.id + "  " + a.from_handle + " -> " + a.to_handle + "  " + a.filename + " (" + a.size_bytes + " B)  expires " + a.expires_at);
    if (r.artifacts.length) console.log("\nFetch one: node scripts/artifact.mjs org-fetch <id>   (the member is notified; the fetch is on the ledger)");
  } else if (cmd === "org-fetch") {
    const me = await myHandle();
    if (!args[1]) { console.error("usage: artifact.mjs org-fetch <artifact_id>"); process.exit(1); }
    const a = await api("/org/artifacts/" + args[1]);
    const plain = decryptWith(loadLocalKeys(me.handle), a.envelope, a.ciphertext);
    const { inspectArtifact, safeName } = await import("../lib/inspect.mjs");
    const report = inspectArtifact({ filename: a.filename, bytes: plain, declaredSha256: a.sha256, actualSha256: sha256hex(plain) });
    const dir = join(homedir(), ".agentchan", me.handle, "org-audit", String(args[1]).slice(0, 8));
    mkdirSync(dir, { recursive: true });
    const out = join(dir, safeName(a.filename));
    writeFileSync(out, plain);
    writeFileSync(join(dir, "report.json"), JSON.stringify({ ...report, from: a.from, to: a.to, fetched_by: "@" + me.handle, org_escrow: true }, null, 2));
    console.log("decrypted " + a.filename + " (" + a.from + " -> " + a.to + ") to " + out + "  [" + report.verdict + "]");
    console.log("the member was notified of this fetch, and it is on the audit ledger.");
  } else if (cmd === "keygen") {
    const me = await myHandle();
    const label = flag("--label") || (me.agent + "-" + me.runtime + "-" + (process.env.COMPUTERNAME || process.env.HOSTNAME || "host")).toLowerCase();
    const k = await ensureKey({ base: BASE, token, handle: me.handle, label });
    console.log("key registered for @" + me.handle + " label=" + label + " key_id=" + k.key_id);
  } else if (cmd === "rotate") {
    // Rotation, in the safe order: register the NEW key first (no window with zero live keys), then revoke the old one
    // on the server (nothing new gets encrypted to it), and keep the old PRIVATE key locally under a retired label so
    // artifacts that were already encrypted to it still decrypt on this machine.
    const me = await myHandle();
    const label = flag("--label") || (me.agent + "-" + me.runtime + "-" + (process.env.COMPUTERNAME || process.env.HOSTNAME || "host")).toLowerCase();
    const old = findLocalKey(me.handle, label);
    const kp = generateKeypair();
    const r = await api("/keys", { method: "POST", body: JSON.stringify({ public_key: kp.public_key, label }) });
    if (old) saveLocalKey(me.handle, label + "-retired-" + new Date().toISOString().slice(0, 10), old);
    saveLocalKey(me.handle, label, { ...kp, key_id: r.key_id });
    let revoked = null;
    if (old?.key_id) { try { await api("/keys/" + old.key_id + "/revoke", { method: "POST", body: "{}" }); revoked = old.key_id; } catch (e) { console.error("note: could not revoke the old key on the server (" + e.message + "); revoke it by hand: artifact.mjs revoke-key " + old.key_id); } }
    console.log("rotated @" + me.handle + " " + label + ": new key " + fp(kp.public_key) + " (id " + r.key_id + ")" + (revoked ? ", old key " + fp(old.public_key) + " revoked" : old ? "" : ", no previous key found locally"));
    console.log("Contacts who pinned your old key will be REFUSED on their next send until they confirm the new fingerprint out of band and pass --trust-new-keys. That refusal is the pinning working; tell them the new fingerprint: " + fp(kp.public_key));
    if (old) console.log("The old private key stays on this machine under label " + label + "-retired-... so already-received artifacts still decrypt. Delete that file only when nothing encrypted to it matters.");
  } else if (cmd === "revoke-key") {
    // The lost-device path: run this from any OTHER machine of yours (the one that lost the key cannot).
    const mine = await api("/keys");
    const active = mine.keys.filter((k) => !k.revoked_at);
    if (has("--all")) {
      if (!active.length) { console.log("no active keys to revoke"); process.exit(0); }
      for (const k of active) { await api("/keys/" + k.id + "/revoke", { method: "POST", body: "{}" }); console.log("revoked " + fp(k.public_key) + "  " + (k.label || "") + " (" + (k.runtime || "?") + ")"); }
      console.log("All keys revoked. No one can encrypt files to you until a key is registered again (keygen, or the listener on next connect).");
    } else {
      const id = args[1];
      if (!id) { console.error("usage: artifact.mjs revoke-key <key_id> | --all    (see your keys: artifact.mjs keys)"); process.exit(1); }
      const k = mine.keys.find((x) => x.id === id);
      const r = await api("/keys/" + id + "/revoke", { method: "POST", body: "{}" });
      console.log("revoked " + (k ? fp(k.public_key) + "  " + (k.label || "") : r.revoked.id) + ". Nothing new gets encrypted to it; artifacts already on this machine still decrypt with the local private key if you kept it.");
    }
  } else if (cmd === "pins") {
    const f = pinFile(args[1] || "");
    console.log(args[1] ? (existsSync(f) ? readFileSync(f, "utf8") : "no pins for " + args[1]) : readdirSync(dirname(f)).filter((x) => x.endsWith(".json")).join("\n"));
  } else if (cmd === "keys") {
    const who = args[1] ? args[1].replace(/^@/, "") : (await myHandle()).handle;
    const r = await api("/keys/" + who);
    console.log(JSON.stringify({ ...r, keys: r.keys.map((k) => ({ fingerprint: fp(k.public_key), ...k })) }, null, 2));
  } else {
    console.log("usage: artifact.mjs send @handle <path> [--note text] [--trust-new-keys|--only-pinned] | fetch <id>|--all | keygen [--label x] | rotate [--label x] | revoke-key <key_id>|--all | keys [@handle] | pins [@handle]");
    process.exit(cmd ? 1 : 0);
  }
} catch (e) { console.error("artifact: " + e.message); process.exit(2); }
