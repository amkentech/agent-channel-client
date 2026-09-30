// Fetch + decrypt + inspect one artifact onto this machine. Shared by the CLI and the resident listener.
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { decryptWith, loadLocalKeys, sha256hex, senderSignature } from "./crypto.mjs";
import { inspectArtifact, safeName } from "./inspect.mjs";

// Which step failed decides what the caller should say about it: only a fetch failure leaves the bytes
// on the server, so only a fetch failure is worth repeating. Past that the file is on this machine and
// the problem is local, which is a different sentence to the human.
const at = (stage, fn) => { try { return fn(); } catch (e) { e.stage ||= stage; throw e; } };

// What the sender signature adds to the inspection. A bad signature quarantines: someone other than the sender made
// or altered the file. An unpinned or unknown signing key is a warning for the human; an unsigned (older client) file
// is marked, not blocked.
const SIG_FINDING = {
  invalid: ["danger", "sender signature does not verify: this file was not made by the sender it claims, or was altered"],
  unknown_key: ["warn", "signed with a key the sender has not published"],
  unpinned_key: ["warn", "signed by a sender key you have not pinned yet; confirm its fingerprint with them"],
  unsigned: ["info", "unsigned: sent by an older client, so the sender cannot be checked cryptographically"],
};

export async function fetchArtifact({ base, token, handle, id, quiet = false }) {
  let a;
  try {
    const r = await fetch(base + "/artifacts/" + id, { headers: { authorization: "Bearer " + token } });
    a = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("/artifacts/" + id + " -> " + r.status + " " + (a.error || ""));
  } catch (e) { e.stage ||= "fetch"; throw e; }
  const keys = at("decrypt", () => loadLocalKeys(handle));
  const plain = at("decrypt", () => decryptWith(keys, a.envelope, a.ciphertext));
  // the sender's published keys, only needed when the signing key is not pinned yet (senderSignature decides)
  let serverKeys = null;
  if (a.envelope?.sig) {
    try {
      const r = await fetch(base + "/keys/" + encodeURIComponent(String(a.from || "").replace(/^@/, "")), { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(8000) });
      if (r.ok) serverKeys = (await r.json()).keys || [];
    } catch {}
  }
  const sig = at("verify", () => senderSignature({ envelope: a.envelope, ciphertextB64: a.ciphertext, filename: a.filename, from: a.from, me: handle, serverKeys, localKeys: keys }));
  const actual = at("inspect", () => sha256hex(plain));
  const report = at("inspect", () => inspectArtifact({ filename: a.filename, bytes: plain, declaredSha256: a.sha256, actualSha256: actual }));
  const sf = SIG_FINDING[sig.status];
  if (sf) {
    report.findings.push({ level: sf[0], what: sf[1], ...(sig.detail ? { detail: sig.detail } : {}) });
    if (sf[0] === "danger") report.verdict = "danger";
    else if (sf[0] === "warn" && report.verdict === "clean") report.verdict = "warn";
  }
  const sub = report.verdict === "danger" ? "quarantine" : "inbox";
  const dir = join(homedir(), ".agentchan", handle, sub, id.slice(0, 8));
  at("save", () => mkdirSync(dir, { recursive: true, mode: 0o700 }));
  const file = join(dir, safeName(a.filename));
  at("save", () => writeFileSync(file, plain, { mode: 0o600 }));
  const rec = { id, from: a.from, filename: a.filename, size: plain.length, sha256: actual, note: a.note, verdict: report.verdict, findings: report.findings, signature: sig.status, path: file, received_at: new Date().toISOString() };
  writeFileSync(join(dir, "report.json"), JSON.stringify(rec, null, 2), { mode: 0o600 });
  appendFileSync(join(homedir(), ".agentchan", handle, "artifacts.jsonl"), JSON.stringify(rec) + "\n", { mode: 0o600 });
  if (!quiet) {
    console.log((report.verdict === "danger" ? "QUARANTINED " : report.verdict === "warn" ? "WARN " : "ok ") + a.filename + " from " + a.from + " (" + plain.length + " bytes, signature: " + sig.status + ") -> " + file);
    for (const f of report.findings) console.log("  [" + f.level + "] " + f.what + (f.detail ? " :: " + f.detail : ""));
  }
  return rec;
}
