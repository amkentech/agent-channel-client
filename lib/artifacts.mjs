// Fetch + decrypt + inspect one artifact onto this machine. Shared by the CLI and the resident listener.
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { decryptWith, loadLocalKeys, sha256hex } from "./crypto.mjs";
import { inspectArtifact, safeName } from "./inspect.mjs";

// Which step failed decides what the caller should say about it: only a fetch failure leaves the bytes
// on the server, so only a fetch failure is worth repeating. Past that the file is on this machine and
// the problem is local, which is a different sentence to the human.
const at = (stage, fn) => { try { return fn(); } catch (e) { e.stage ||= stage; throw e; } };

export async function fetchArtifact({ base, token, handle, id, quiet = false }) {
  let a;
  try {
    const r = await fetch(base + "/artifacts/" + id, { headers: { authorization: "Bearer " + token } });
    a = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("/artifacts/" + id + " -> " + r.status + " " + (a.error || ""));
  } catch (e) { e.stage ||= "fetch"; throw e; }
  const keys = at("decrypt", () => loadLocalKeys(handle));
  const plain = at("decrypt", () => decryptWith(keys, a.envelope, a.ciphertext));
  const actual = at("inspect", () => sha256hex(plain));
  const report = at("inspect", () => inspectArtifact({ filename: a.filename, bytes: plain, declaredSha256: a.sha256, actualSha256: actual }));
  const sub = report.verdict === "danger" ? "quarantine" : "inbox";
  const dir = join(homedir(), ".agentchan", handle, sub, id.slice(0, 8));
  at("save", () => mkdirSync(dir, { recursive: true }));
  const file = join(dir, safeName(a.filename));
  at("save", () => writeFileSync(file, plain));
  const rec = { id, from: a.from, filename: a.filename, size: plain.length, sha256: actual, note: a.note, verdict: report.verdict, findings: report.findings, path: file, received_at: new Date().toISOString() };
  writeFileSync(join(dir, "report.json"), JSON.stringify(rec, null, 2));
  appendFileSync(join(homedir(), ".agentchan", handle, "artifacts.jsonl"), JSON.stringify(rec) + "\n");
  if (!quiet) {
    console.log((report.verdict === "danger" ? "QUARANTINED " : report.verdict === "warn" ? "WARN " : "ok ") + a.filename + " from " + a.from + " (" + plain.length + " bytes) -> " + file);
    for (const f of report.findings) console.log("  [" + f.level + "] " + f.what + (f.detail ? " :: " + f.detail : ""));
  }
  return rec;
}
