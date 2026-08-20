// Fetch + decrypt + inspect one artifact onto this machine. Shared by the CLI and the resident listener.
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { decryptWith, loadLocalKeys, sha256hex } from "./crypto.mjs";
import { inspectArtifact, safeName } from "./inspect.mjs";

export async function fetchArtifact({ base, token, handle, id, quiet = false }) {
  const r = await fetch(base + "/artifacts/" + id, { headers: { authorization: "Bearer " + token } });
  const a = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("/artifacts/" + id + " -> " + r.status + " " + (a.error || ""));
  const keys = loadLocalKeys(handle);
  const plain = decryptWith(keys, a.envelope, a.ciphertext);
  const actual = sha256hex(plain);
  const report = inspectArtifact({ filename: a.filename, bytes: plain, declaredSha256: a.sha256, actualSha256: actual });
  const sub = report.verdict === "danger" ? "quarantine" : "inbox";
  const dir = join(homedir(), ".agentchan", handle, sub, id.slice(0, 8));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, safeName(a.filename));
  writeFileSync(file, plain);
  const rec = { id, from: a.from, filename: a.filename, size: plain.length, sha256: actual, note: a.note, verdict: report.verdict, findings: report.findings, path: file, received_at: new Date().toISOString() };
  writeFileSync(join(dir, "report.json"), JSON.stringify(rec, null, 2));
  appendFileSync(join(homedir(), ".agentchan", handle, "artifacts.jsonl"), JSON.stringify(rec) + "\n");
  if (!quiet) {
    console.log((report.verdict === "danger" ? "QUARANTINED " : report.verdict === "warn" ? "WARN " : "ok ") + a.filename + " from " + a.from + " (" + plain.length + " bytes) -> " + file);
    for (const f of report.findings) console.log("  [" + f.level + "] " + f.what + (f.detail ? " :: " + f.detail : ""));
  }
  return rec;
}
