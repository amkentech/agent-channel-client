// The merge check: `agent-channel receipt check <base>..<head>`. docs/RECEIPTS.md "Flow" step 4, "Wire contract" and
// "Enforcement".
//
// ENFORCED BY DEFAULT (strict). Every commit in the range must be covered by exactly one kind of evidence:
//   agent-authored  = a Co-Authored-By trailer from a known runtime (lib/agent-runtimes.json), OR an Agent-Receipt
//                     trailer, OR a sighting from GET /sightings (only when a token is available; otherwise the output
//                     says "sightings not checked", never silently).
//   agent-authored commits need ONE receipt that: verifies offline (digest, Ed25519 signature, every fact's Merkle
//     proof, trailer root = signed root); names this repo; binds this commit by sha OR `git patch-id --stable`
//     (survives rebase/amend); covers the commit's ACTUAL changed paths from git diff-tree -- both the binding's
//     path list and the scope globs, which is what catches an agent that under-reported paths at mint; and is not
//     revoked at or before its issue time (GET /receipts/:id/status). Status unreachable = FAIL "revocation
//     unverified" unless --allow-offline.
//   every other commit that changes a protected path (default: EVERY path, "**"; --protected narrows it) needs a valid
//     Human-Authored declaration covering it. Without one its provenance is unknown: no agent signal, but nothing says a
//     person wrote it either (a stripped trailer, a disabled sighting hook, or an unmanaged runtime look exactly like
//     this), and the check fails it as "unknown provenance". A Human-Authored declaration never covers an
//     agent-authored commit: "I wrote this myself" and "Co-Authored-By: <agent>" cannot both be true.
//   A Human-Authored trailer that does not verify fails in every mode: a forged declaration is not neutral.
//   PR-body trailers are candidates to COVER a commit, never a signal that a commit is agent-authored: a PR mixing
//   human and agent commits carries a receipt for the agent ones, and that must not turn the human ones into failures.
//
// --report-only is the one explicit opt-out: the same evaluation, printed in full, but an unmarked commit with no
//   declaration passes as human (flagged "unknown provenance ... passes only because of --report-only") and the exit
//   code is 0 whatever the verdict. Agent-authored failures are still reported as FAIL lines.
//
// evaluate() is the whole decision, with every input injected (commits, sightings, document and status fetchers, the
// public key). checkRange() feeds it from git + the channel's HTTP routes; the server's GitHub App check
// (src/github-app.js) feeds it from the GitHub API + its own database. One decision, two transports.
import {
  verifyReceiptDoc, verifyDeclarationDoc, findCommitEntry, revocationValid, repoInScope, pathAllowed, globToRegex,
  resolvePublicKey, NOT_PINNED_NOTE,
} from "./receipt-verify.mjs";
import { commitsInRange, commitInfo, coAuthorRuntimes, prBodyTrailers, repoOf } from "./receipt-git.mjs";
import { createHash } from "node:crypto";

const trimBase = (s) => String(s || "https://channel.amkentech.com").replace(/\/mcp\/?$/, "").replace(/\/$/, "");
/** Default protected globs: every path. Strict means every commit, unless the caller narrows it on purpose. */
export const ALL_PATHS = ["**"];
/** The marker name the sighting hook adds when AGENTCHAN_NO_SIGHTING was set in an agent session (lib/receipt-sighting.mjs). */
export const OPT_OUT_MARKER = "AGENTCHAN_NO_SIGHTING";

async function getJson(url, { token, timeoutMs = 10000 } = {}) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json", ...(token ? { authorization: "Bearer " + token } : {}) } });
  const text = await r.text();
  if (!r.ok) { const e = new Error("HTTP " + r.status + (text ? ": " + text.slice(0, 160) : "")); e.status = r.status; throw e; }
  return JSON.parse(text);
}

/** Index sighting rows by sha and patch-id: -> Map("sha:<x>" | "pid:<x>" -> [rows]). */
export function indexSightings(rows) {
  const byKey = new Map();
  const add = (k, s) => { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(s); };
  for (const s of rows || []) {
    if (s.sha) add("sha:" + String(s.sha).toLowerCase(), s);
    if (s.patch_id) add("pid:" + String(s.patch_id).toLowerCase(), s);
  }
  return byKey;
}

/**
 * The decision, transport-free.
 * input: {
 *   repo, commits: [{ sha, subject, paths, patch_id, trailers: { receipts, declarations, coAuthors } }], prBody,
 *   sightings: { checked, note, error?, byKey: Map },   // indexSightings()
 *   fetchDoc(kind, id) -> Promise<{ d } | { e }>,        // kind "receipts" | "declarations"
 *   fetchStatus(id) -> Promise<{ d } | { e }>,
 *   key() -> Promise<{ pem, pinned, from, error? }>,
 *   allowOffline, reportOnly, protectedGlobs (default ["**"]), notes: []
 * }
 * -> { ok, mode, strict, protected, commits: [...], failures, unknown_provenance, sightings, allow_offline, notes }
 */
export async function evaluate(input) {
  const repo = input.repo || null;
  const reportOnly = !!input.reportOnly;
  const allowOffline = !!input.allowOffline;
  const protectedGlobs = (input.protectedGlobs || []).filter(Boolean);
  const globs = protectedGlobs.length ? protectedGlobs : ALL_PATHS;
  const sightings = input.sightings || { checked: false, note: "sightings not checked", byKey: new Map() };
  const pr = input.prBody ? prBodyTrailers(input.prBody) : { receipts: [], declarations: [] };
  const { fetchDoc, fetchStatus, key } = input;

  /** Does receipt trailer `t` validly cover commit `c`? -> { ok, reasons[], warnings[], by } */
  async function receiptCovers(t, c) {
    const reasons = [], warnings = [];
    const got = await fetchDoc("receipts", t.id);
    if (got.e) return { ok: false, reasons: ["receipt " + t.id + " could not be fetched: " + got.e.message], warnings };
    const k = await key();
    if (!k.pem) reasons.push("signature unverifiable: " + k.error);
    const v = verifyReceiptDoc(got.d, k.pem, { receipt_id: t.id, root: t.root });
    for (const p of v.problems) if (!(k.pem === null && /public key/.test(p))) reasons.push(p);
    if (!t.root) reasons.push("Agent-Receipt trailer carries no root hash (expected 'Agent-Receipt: <id> <root>')");
    const b = v.binding;
    let match = null;
    if (b) {
      if (!repo) reasons.push("cannot confirm the receipt's repo (" + b.repo + "): this checkout's repo is unknown; pass --repo");
      else if (String(b.repo).toLowerCase() !== repo) reasons.push("receipt binds repo " + b.repo + ", this is " + repo);
      match = findCommitEntry(b.commits, c.sha, c.patch_id);
      if (!match) reasons.push("commit not in the receipt's binding (neither sha " + c.sha.slice(0, 12) + " nor patch-id " + (c.patch_id ? c.patch_id.slice(0, 12) : "(none)") + " is listed)");
      else {
        const bound = new Set((match.entry.paths || []).map(String));
        const escaped = c.paths.filter((p) => !bound.has(p));
        if (escaped.length) reasons.push("changed path(s) not in the receipt's binding for this commit: " + escaped.join(", "));
      }
    }
    if (c.paths_unknown) reasons.push("this commit's changed paths could not be determined (" + c.paths_unknown + "), so scope cannot be confirmed");
    const s = v.scope;
    if (s) {
      const outside = c.paths.filter((p) => !pathAllowed(p, s.paths));
      if (outside.length) reasons.push("changed path(s) outside the authorized scope (" + (s.paths || []).join(", ") + "): " + outside.join(", "));
      if (repo && !repoInScope(repo, s.repos)) reasons.push("repo " + repo + " is outside the authorized scope repos (" + s.repos.join(", ") + ")");
      if (s.expires_at && v.body?.issued_at && Date.parse(v.body.issued_at) > Date.parse(s.expires_at)) reasons.push("receipt issued " + v.body.issued_at + " after the authorization expired " + s.expires_at);
    } else if (v.body) reasons.push("receipt has no scope fact");
    // revocation: the one online question
    const st = await fetchStatus(t.id);
    if (st.e) {
      if (allowOffline) warnings.push("revocation NOT checked (--allow-offline): " + st.e.message);
      else reasons.push("revocation unverified: GET /receipts/" + t.id + "/status failed (" + st.e.message + "); pass --allow-offline to accept that risk explicitly");
    } else {
      if (st.d.receipt_id && st.d.receipt_id !== t.id) reasons.push("status endpoint answered for a different receipt (" + st.d.receipt_id + ")");
      const rv = revocationValid(st.d, v.body?.issued_at);
      if (!rv.ok) reasons.push(rv.why);
      else if (rv.note) warnings.push(rv.note);
    }
    return { ok: reasons.length === 0, reasons, warnings, by: match?.by || null, receipt_id: t.id, issued_at: v.body?.issued_at ?? null };
  }

  async function declarationCovers(t, c) {
    const reasons = [];
    const got = await fetchDoc("declarations", t.id);
    if (got.e) return { ok: false, reasons: ["declaration " + t.id + " could not be fetched: " + got.e.message] };
    const k = await key();
    if (!k.pem) reasons.push("signature unverifiable: " + k.error);
    const v = verifyDeclarationDoc(got.d, k.pem, { declaration_id: t.id });
    for (const p of v.problems) if (!(k.pem === null && /public key/.test(p))) reasons.push(p);
    let match = null;
    if (v.body) {
      if (!repo) reasons.push("cannot confirm the declaration's repo: this checkout's repo is unknown; pass --repo");
      else if (String(v.body.repo || "").toLowerCase() !== repo) reasons.push("declaration names repo " + v.body.repo + ", this is " + repo);
      match = findCommitEntry(v.body.commits, c.sha, c.patch_id);
      if (!match) reasons.push("declaration does not name this commit (by sha or patch-id)");
    }
    return { ok: reasons.length === 0, reasons, by: match?.by || null, declaration_id: t.id, person: v.body?.person ?? null };
  }

  const results = [];
  for (const c of input.commits) {
    const receiptsT = [...c.trailers.receipts, ...pr.receipts.map((r) => ({ ...r, from: "pr-body" }))];
    const declsT = [...c.trailers.declarations, ...pr.declarations.map((d) => ({ ...d, from: "pr-body" }))];
    const runtimes = coAuthorRuntimes(c.trailers.coAuthors);
    const allSeen = [...(sightings.byKey.get("sha:" + c.sha.toLowerCase()) || []), ...(c.patch_id ? sightings.byKey.get("pid:" + c.patch_id.toLowerCase()) || [] : [])];
    // counts: false = recorded, but posted by someone who is neither the commit's author nor a party to a contract
    // naming this repo (server rule, src/receipts.js qualifySightings): reported, never allowed to change the verdict
    const seen = allSeen.filter((s) => s.counts !== false);
    const ignored = [...new Map(allSeen.filter((s) => s.counts === false).map((s) => [s.innermost + "|" + (s.handle || ""), s])).values()];
    const signals = [
      ...runtimes.map((r) => "Co-Authored-By " + r.label + " (" + r.value + ")"),
      ...c.trailers.receipts.map((r) => "Agent-Receipt trailer " + r.id),
      ...[...new Map(seen.map((s) => [s.innermost + "|" + (s.handle || "") + "|" + !!s.opt_out, s])).values()].map((s) => "sighting: " + (s.innermost || "unknown runtime") + " session at commit time" + (s.handle ? " (" + s.handle + ")" : "") + (s.opt_out ? " with " + OPT_OUT_MARKER + " set (the opt-out was ignored: it only silences commits made outside an agent session)" : "")),
    ];
    const agent = signals.length > 0;
    // paths_unknown (server side: a merge whose own changes the API could not give) counts as touching everything
    const protectedHits = c.paths_unknown ? ["(paths unknown)"] : c.paths.filter((p) => globs.some((g) => globToRegex(g).test(p) || p === g));
    const r = { sha: c.sha, subject: c.subject, paths: c.paths, patch_id: c.patch_id, agent_authored: agent, agent_signals: signals, protected_paths: protectedHits, status: "pass", reasons: [], warnings: [], covered_by: null, provenance: agent ? "agent" : "unknown" };
    if (c.paths_unknown) r.paths_unknown = c.paths_unknown;
    if (c.patch_id_note) r.warnings.push(c.patch_id_note);
    for (const s of ignored) r.warnings.push("sighting of a " + (s.innermost || "unknown") + " session by " + (s.handle || "an unknown account") + " recorded but NOT counted: " + (s.not_counted || "poster not qualified"));

    if (agent) {
      if (!receiptsT.length) r.reasons.push("agent-authored (" + signals.join("; ") + ") but no Agent-Receipt trailer");
      else {
        const tried = [];
        for (const t of receiptsT) { const x = await receiptCovers(t, c); tried.push(x); if (x.ok) { r.covered_by = { receipt: t.id, by: x.by, issued_at: x.issued_at }; r.warnings.push(...x.warnings); break; } }
        if (!r.covered_by) for (const x of tried) r.reasons.push(...x.reasons.map((m) => (receiptsT.length > 1 ? "[" + x.receipt_id + "] " : "") + m));
      }
      if (declsT.length && !r.covered_by) r.reasons.push("a Human-Authored declaration cannot cover an agent-authored commit");
    } else {
      let validDecl = null;
      for (const t of declsT) {
        const x = await declarationCovers(t, c);
        if (x.ok) { validDecl = x; break; }
        r.reasons.push(...x.reasons.map((m) => "Human-Authored " + t.id + ": " + m));
      }
      if (validDecl) { r.reasons = []; r.covered_by = { declaration: validDecl.declaration_id, by: validDecl.by, person: validDecl.person }; r.provenance = "human-declared"; }
      else if (!protectedHits.length) r.provenance = "no-protected-change";
      else if (!declsT.length) {
        const why = "unknown provenance: no agent signal (no runtime Co-Authored-By, no Agent-Receipt, " + (sightings.checked ? "no sighting" : "sightings not checked") + ") and no Human-Authored declaration, and it changes " + (c.paths_unknown ? "paths that could not be determined" : "protected path(s) " + protectedHits.slice(0, 20).join(", ") + (protectedHits.length > 20 ? " … and " + (protectedHits.length - 20) + " more" : ""));
        if (reportOnly) r.warnings.push(why + "; passes as human only because of --report-only");
        else r.reasons.push(why + ". Enforced: an agent commit needs an Agent-Receipt, a person's own commit needs a Human-Authored declaration (agent-channel receipt declare)");
      }
    }
    if (r.reasons.length) r.status = "fail";
    results.push(r);
  }

  const failures = results.filter((r) => r.status === "fail").length;
  const sightingsFail = !!sightings.error && !allowOffline;
  return {
    ok: failures === 0 && !sightingsFail, repo, mode: reportOnly ? "report-only" : "enforced", strict: true, protected: globs,
    sightings: { checked: !!sightings.checked, note: sightings.note, failed: sightingsFail },
    allow_offline: allowOffline, commits: results, failures,
    unknown_provenance: results.filter((r) => r.provenance === "unknown" && !r.agent_authored && !r.covered_by && r.protected_paths.length).length,
    notes: input.notes || [],
  };
}

/**
 * opts: { cwd, range, server, publicKeyFile, token, allowOffline, reportOnly, protectedGlobs[], repo, prBody, timeoutMs }
 * -> { ok, mode, repo, range, server, key: {pinned, from, note}, sightings: {checked, note}, commits: [...], notes: [...] }
 * `strict` is accepted and ignored: strict is the only enforced mode (docs/RECEIPTS.md "Enforcement").
 */
export async function checkRange(opts) {
  const server = trimBase(opts.server);
  const cwd = opts.cwd || process.cwd();
  const timeoutMs = opts.timeoutMs ?? 10000;
  const notes = [];
  const repo = repoOf(cwd, opts.repo);
  if (!repo) notes.push("repo unknown: this checkout has no origin remote in host/owner/name form; pass --repo host/owner/name (agent-authored commits cannot be matched to a receipt's repo without it)");
  const shas = commitsInRange(cwd, opts.range);
  const commits = shas.map((s) => commitInfo(cwd, s));

  // ---- sightings (agent detection that survives a stripped trailer) ----
  const sightings = { checked: false, note: "", byKey: new Map() };
  if (!opts.token) sightings.note = "sightings not checked: no Agent Channel token (set AGENTCHAN_TOKEN or pass --runtime with a saved token); only trailers were used to detect agent-authored commits";
  else if (!repo) sightings.note = "sightings not checked: repo unknown";
  else if (!commits.length) { sightings.checked = true; sightings.note = "sightings checked (no commits)"; }
  else {
    try {
      const rows = [];
      for (let i = 0; i < commits.length; i += 50) {
        const part = commits.slice(i, i + 50);
        const chunk = part.map((c) => c.sha).join(",");
        // author email HASHES (never addresses) so the server can count a sighting as the commit author's own
        const authors = part.filter((c) => c.author_email).map((c) => c.sha + ":" + createHash("sha256").update(c.author_email.trim().toLowerCase()).digest("hex")).join(",");
        const got = await getJson(server + "/sightings?repo=" + encodeURIComponent(repo) + "&shas=" + encodeURIComponent(chunk) + (authors ? "&authors=" + encodeURIComponent(authors) : ""), { token: opts.token, timeoutMs });
        rows.push(...(Array.isArray(got) ? got : got?.sightings || []));
      }
      sightings.byKey = indexSightings(rows);
      sightings.checked = true;
      sightings.note = "sightings checked: " + rows.length + " sighting(s) for this range";
    } catch (e) {
      sightings.error = e.message;
      sightings.note = (opts.allowOffline ? "sightings NOT checked (--allow-offline): " : "sightings unverified: ") + "GET /sightings failed: " + e.message;
    }
  }

  // ---- public key, lazily: only if something needs verifying ----
  let keyP = null;
  const key = () => (keyP ||= resolvePublicKey({ publicKeyFile: opts.publicKeyFile, server, timeoutMs }));
  const docCache = new Map(), statusCache = new Map();
  const fetchDoc = (kind, id) => {
    const k = kind + ":" + id;
    if (!docCache.has(k)) docCache.set(k, getJson(server + "/" + kind + "/" + encodeURIComponent(id) + ".json", { timeoutMs }).then((d) => ({ d }), (e) => ({ e })));
    return docCache.get(k);
  };
  const fetchStatus = (id) => {
    if (!statusCache.has(id)) statusCache.set(id, getJson(server + "/receipts/" + encodeURIComponent(id) + "/status", { timeoutMs }).then((d) => ({ d }), (e) => ({ e })));
    return statusCache.get(id);
  };

  const res = await evaluate({ repo, commits, prBody: opts.prBody, sightings, fetchDoc, fetchStatus, key,
    allowOffline: opts.allowOffline, reportOnly: opts.reportOnly, protectedGlobs: opts.protectedGlobs, notes });
  const k = keyP ? await keyP : null;
  const keyInfo = k ? { pinned: k.pinned, from: k.from, error: k.error || null, note: k.pinned ? null : NOT_PINNED_NOTE } : { pinned: !!opts.publicKeyFile, from: opts.publicKeyFile || null, note: "no signed document needed verifying" };
  return { ...res, range: opts.range, server, key: keyInfo };
}

/** Human output: one line per commit, failing ones with every reason, then the summary. */
export function formatHuman(res) {
  const L = [];
  const narrowed = !(res.protected.length === 1 && res.protected[0] === "**");
  L.push("receipt check " + res.range + " in " + (res.repo || "(repo unknown)") + " [" + res.mode + (narrowed ? "; declarations required on " + res.protected.join(",") : "; every commit needs a receipt or a declaration") + "] against " + res.server);
  for (const n of res.notes) L.push("note: " + n);
  L.push((res.sightings.failed ? "FAIL: " : "") + res.sightings.note);
  if (res.key.from && !res.key.pinned) L.push("note: " + res.key.note + " (" + res.key.from + ")");
  else if (res.key.pinned) L.push("public key pinned: " + res.key.from);
  if (res.allow_offline) L.push("note: --allow-offline: an unreachable revocation check is a warning, not a failure");
  for (const c of res.commits) {
    const head = c.sha.slice(0, 12) + " " + (c.subject || "").slice(0, 72);
    if (c.status === "fail") { L.push("FAIL " + head); for (const m of c.reasons) L.push("     - " + m); }
    else {
      const why = c.covered_by?.receipt ? "receipt " + c.covered_by.receipt + " (bound by " + c.covered_by.by + ")"
        : c.covered_by?.declaration ? "Human-Authored " + c.covered_by.declaration + " by " + c.covered_by.person + " (bound by " + c.covered_by.by + ")"
        : c.provenance === "no-protected-change" ? "not agent-authored; changes no protected path"
        : "not agent-authored; provenance unknown (report-only)";
      L.push("ok   " + head + "  [" + why + "]");
    }
    for (const w of c.warnings) L.push("     ! " + w);
  }
  const n = res.commits.length;
  const unk = res.unknown_provenance ? "; " + res.unknown_provenance + " of unknown provenance" : "";
  L.push(res.ok ? "PASS: " + n + " commit(s) checked, 0 failing" + unk : "FAIL: " + res.failures + " of " + n + " commit(s) failing" + unk + (res.sightings.failed ? "; sightings unverified" : ""));
  return L.join("\n");
}
