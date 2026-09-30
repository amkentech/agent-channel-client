#!/usr/bin/env node
// agent-channel ledger [check|status|ack] [--runtime <key>] [--pages N]
//   check (default)  fetch the signed ledger head now and verify it extends the head this machine stored last
//   status           the stored head and any open alerts, with their signed evidence summarized (no network)
//   ack              a human has read the open alerts: stop showing them (a fork rebases the witness on the head the
//                    server now shows; a key change pins the new key). The evidence stays in ledger-forks.jsonl.
// Files: ~/.agentchan/ledger-heads.jsonl, ledger-forks.jsonl, ledger-forks-ack.json, ledger-keys.json (docs/VERIFY.md).
import { checkLedger, ledgerAlerts, ackLedgerAlerts, lastVerifiedHead, alertLine, ledgerForkFile, ledgerHeadFile } from "../lib/ledger-head.mjs";
import { HOME_STORE, BASE, tokenFor } from "../lib/paths.mjs";

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const cmd = argv.find((a, i) => !a.startsWith("--") && !["--runtime", "--pages"].includes(argv[i - 1])) || "check";
const runtime = opt("--runtime") || process.env.AGENTCHAN_RUNTIME || "claude";
const server = BASE.replace(/\/$/, "");

function status() {
  const head = lastVerifiedHead(HOME_STORE, server);
  console.log("server: " + server);
  console.log(head ? "verified head: seq " + head.seq + " " + head.hash.slice(0, 16) + "… (" + head.how + ", seen " + head.seen_at + ")" : "no verified head stored yet (the next check pins one)");
  const open = ledgerAlerts(HOME_STORE, server);
  if (!open.length) { console.log("no open ledger alerts"); return 0; }
  for (const a of open) {
    console.log("\n⚠ " + alertLine(a));
    console.log("  id " + a.id + ", recorded " + a.at);
    if (a.evidence?.head?.signed?.signature) console.log("  evidence: the server's signed head (kid " + a.evidence.head.signed.signature.kid + ", signed " + a.evidence.head.signed.signature.signed_at + ")" + (a.evidence.consistency ? " and its signed consistency page" : "") + " are in " + ledgerForkFile(HOME_STORE));
  }
  console.log("\nKeep " + ledgerForkFile(HOME_STORE) + " and " + ledgerHeadFile(HOME_STORE) + ": two signed statements from the same key that cannot both be true are evidence the operator cannot explain away.");
  console.log("Run `agent-channel ledger ack` once you have read this.");
  return 2;
}

if (cmd === "status") process.exit(status());
if (cmd === "ack") {
  const done = ackLedgerAlerts(HOME_STORE, server);
  console.log(done.length ? "acknowledged " + done.length + " alert(s): " + done.map((a) => a.id).join(", ") : "no open ledger alerts");
  process.exit(0);
}
if (cmd !== "check") { console.error("usage: agent-channel ledger [check|status|ack] [--runtime <key>] [--pages N]"); process.exit(1); }
const token = tokenFor(runtime);
const headers = token ? { authorization: "Bearer " + token } : {};
const r = await checkLedger({ server, headers, dir: HOME_STORE, maxPages: Math.max(1, Number(opt("--pages")) || 20), timeoutMs: 15000 });
const say = {
  first: "first head pinned: seq " + r.head?.seq + " (later heads are checked against it)",
  same: "head unchanged at seq " + r.head?.seq,
  extended: "head seq " + r.head?.seq + " verified: it extends the head this machine stored",
  partial: "verified through seq " + r.verified_through + " so far; run again to continue to seq " + r.head?.seq,
  unavailable: "could not check: " + r.why,
  unsupported: "this server does not publish a signed ledger head",
  empty: "the ledger is empty",
}[r.status];
if (say) console.log(say);
if (!token && (r.status === "partial" || r.status === "unavailable")) console.log("(no token for runtime " + runtime + ": the consistency view needs one)");
process.exit(status() === 2 ? 2 : r.status === "unavailable" ? 1 : 0);
