// `git patch-id --stable`, reimplemented in JavaScript for callers that have a commit's diff but no git: the server's
// GitHub App check (src/github-app.js) reads commits through the GitHub API, where there is no patch-id, and a receipt
// binds a commit by sha OR patch-id (docs/RECEIPTS.md: an amended-in trailer, a rebase or a cherry-pick changes the
// sha and keeps the patch-id). Without this the server-side check could only match by sha.
//
// Port of get_one_patchid()/flush_one_hunk()/scan_hunk_header()/remove_space() from git's builtin/patch-id.c
// (stable, non-verbatim mode), including its quirks:
//   - lines before the first "diff " line are ignored; "index " lines are never hashed; "\ No newline" lines are skipped
//   - every other header line ("diff --git", "new file mode", "--- a/x", "+++ b/x") IS hashed, whitespace removed
//   - hunk headers are not hashed (line numbers do not matter); hunk bodies are, with all whitespace removed
//   - stable: each file's hash is added into a little-endian running sum with carry, so file order does not matter
//   - a binary file hashes its pre/post blob ids as written on its "index" line, and the "diff " line of the file
//     after a binary one is not hashed (git's own behaviour, reproduced so the ids agree)
// test/receipt-patchid.test.mjs compares it with the real `git patch-id --stable` on real diffs.
//
// Limit, stated where it matters: the id is computed over the diff TEXT it is given. A diff produced with rename
// detection on (the GitHub API's may be) gives a different id than `git diff-tree -p --no-renames`; a binary file's id
// depends on the abbreviation of the blob ids on its index line. In those cases the server-side check can still match
// by sha, and its output says which way each commit was bound.
import { createHash } from "node:crypto";

const isSpace = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\v" || c === "\f";
const removeSpace = (s) => { let o = ""; for (const c of s) if (!isSpace(c)) o += c; return o; };
const isAlpha = (c) => !!c && /[A-Za-z]/.test(c);

/** "@@ -a[,b] +c[,d] @@" -> { before: b (default 1), after: d (default 1) | null }. git ignores scan_hunk_header's
 *  return value; it assigns *p_before before it can bail out and leaves *p_after alone when it does (after = null). */
function scanHunkHeader(line) {
  let q = line.slice(4);
  let m = q.match(/^\d*/)[0];
  let before = 1, after = 1;
  if (q[m.length] === ",") { q = q.slice(m.length + 1); before = parseInt(q, 10) || 0; m = q.match(/^\d*/)[0]; }
  if (m.length === 0 || q[m.length] !== " " || q[m.length + 1] !== "+") return { before, after: null };
  let r = q.slice(m.length + 2);
  const n = r.match(/^\d*/)[0];
  if (r[n.length] === ",") { r = r.slice(n.length + 1); after = parseInt(r, 10) || 0; }
  return { before, after };
}

/**
 * patch-id --stable of one commit's diff (unified diff with `diff --git` headers), as a string or Buffer.
 * -> 40-hex (sha256 repos: 64) or null when the diff hashes nothing (an empty commit), the case where git prints no id.
 */
export function patchIdFromDiff(diff, { algo = "sha1" } = {}) {
  const raw = algo === "sha256" ? 32 : 20;
  const result = new Uint8Array(raw);
  let ctx = createHash(algo);
  const flush = () => {
    const h = ctx.digest();
    ctx = createHash(algo);
    let carry = 0;
    for (let i = 0; i < raw; i++) { carry += result[i] + h[i]; result[i] = carry & 0xff; carry >>= 8; }
  };
  const nextCommit = new RegExp("^[0-9a-fA-F]{" + raw * 2 + "}");
  // git hashes BYTES. A string is taken as UTF-8; either way the text is walked as latin1 (one char per byte) and hashed
  // back as latin1, so non-UTF-8 content hashes exactly as git does. isSpace is ASCII-only, like isspace() in C.
  const bytes = Buffer.isBuffer(diff) ? diff : Buffer.from(String(diff ?? ""), "utf8");
  // strbuf_getwholeline keeps the '\n'; remove_space drops it again, so only the "\ " length test depends on it
  const lines = bytes.toString("latin1").split(/(?<=\n)/);
  let patchlen = 0, before = -1, after = -1, binary = false, pre = "", post = "";
  for (const line of lines) {
    if (line === "") continue;
    let p = line;
    const skipped = line.startsWith("commit ") ? (p = line.slice(7), true) : line.startsWith("From ") ? (p = line.slice(5), true) : false;
    if (!skipped && line.startsWith("\\ ") && line.length > 12) continue;
    // A commit id line: `git diff-tree -p <sha>` starts with one, and in `git log -p` output the next one ends this patch.
    // git returns at every such line; before any hashed content that is this commit's own header, so read on.
    if (nextCommit.test(p)) { if (patchlen) break; continue; }
    if (!patchlen && !line.startsWith("diff ")) continue;
    if (before === -1) {
      if (line.startsWith("GIT binary patch") || line.startsWith("Binary files")) {
        binary = true; before = 0;
        ctx.update(pre, "latin1"); ctx.update(post, "latin1");
        flush();
        continue;
      } else if (line.startsWith("index ")) {
        const dots = line.indexOf("..");
        if (dots !== -1) {
          const sp = line.indexOf(" ", dots);
          const end = sp !== -1 ? sp : line.length - 1;
          pre = line.slice(6, dots).slice(0, raw * 2);
          post = line.slice(dots + 2, end).slice(0, raw * 2);
        }
        continue;
      } else if (line.startsWith("--- ")) { before = after = 1; }
      else if (!isAlpha(line[0])) break;
    }
    if (binary) {
      if (line.startsWith("diff ")) { binary = false; before = -1; }
      continue;
    }
    if (before === 0 && after === 0) {
      if (line.startsWith("@@ -")) {
        const h = scanHunkHeader(line);
        before = h.before;
        if (h.after !== null) after = h.after;
        continue;
      }
      if (!line.startsWith("diff ")) break;
      flush();
      before = after = -1;
    }
    if (line[0] === "-" || line[0] === " ") before--;
    if (line[0] === "+" || line[0] === " ") after--;
    const s = removeSpace(line);
    patchlen += s.length;
    ctx.update(s, "latin1");
  }
  flush();
  if (!patchlen) return null;
  return Buffer.from(result).toString("hex");
}
