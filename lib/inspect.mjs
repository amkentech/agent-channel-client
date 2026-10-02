// File inspection, run twice (docs/SAFETY.md):
//   * sender side, on the plaintext BEFORE it is encrypted (scripts/artifact.mjs send): danger refuses the send;
//   * receiver side, after decrypt and before the file is written (lib/artifacts.mjs): danger quarantines.
// The receiver-side run is the enforceable one: a modified sender client can skip its own check.
//
// What it looks at, with Node built-ins only and never extracting anything to disk:
//   * sha256 mismatch against what the sender declared (receiver side)
//   * executable headers: PE (MZ), ELF, Mach-O
//   * risky names: executable and script extensions, double extensions (invoice.pdf.exe), the right-to-left override
//   * Office macro containers: .docm/.xlsm/.pptm and vbaProject.bin inside any OOXML/zip
//   * zip archives: the central directory is parsed (bounded: entry count, name length, declared sizes), each member's
//     name is judged like a top-level name, and the first bytes of a bounded number of members are read (inflating at
//     most a few KB of compressed input) to catch executable headers behind innocent names. Declared sizes that add up
//     to a decompression bomb are flagged. A zip that cannot be parsed is a warning, not a pass.
// Levels: danger = quarantine / refuse; warn = shown to the human, delivered; info = noted.
// It does not judge text for injection or abuse: that is the pre-send scan (src/scan.js, POST /scan).
import { inflateRawSync, constants as zc } from "node:zlib";

// Run on double-click with no further prompt on some platform, or are shortcuts that can point anywhere.
const EXEC_EXT = new Set(["exe", "dll", "scr", "com", "pif", "msi", "msp", "hta", "cpl", "lnk", "vbs", "vbe", "jse", "wsf", "wsh", "jar", "reg", "application", "gadget", "appref-ms", "scf", "iso", "img", "vhd", "vhdx"]);
// Scripts: routine between developers, so a warning the human sees, not a quarantine.
const SCRIPT_EXT = new Set(["ps1", "psm1", "psd1", "bat", "cmd", "js", "sh", "command", "applescript", "scpt"]);
const MACRO_EXT = new Set(["docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm"]);
const DECOY_EXT = /\.(?:pdf|docx?|xlsx?|pptx?|txt|rtf|jpe?g|png|gif|bmp|mp3|mp4|mov|zip|csv|md|html?)\.([a-z0-9]{2,11})$/i;

export const ZIP_LIMITS = Object.freeze({
  maxEntries: 5000,        // central-directory records walked; more = warn and stop
  headerProbes: 200,       // members whose first bytes are read
  probeCompressedBytes: 4096, // compressed bytes inflated per probe (deflate caps the output near 1000x this)
  bombTotal: 1024 * 1024 * 1024, // declared uncompressed total above this = bomb
  bombRatio: 200,          // declared uncompressed / compressed above this (with total > 50 MB) = bomb
});

const extOf = (name) => { const m = /\.([^./\\]{1,20})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };

function headerKind(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x4d && b[1] === 0x5a) return "PE executable header (MZ)";
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return "ELF executable header";
  const be = b.readUInt32BE(0), le = b.readUInt32LE(0);
  if ([0xfeedface, 0xfeedfacf].includes(be) || [0xfeedface, 0xfeedfacf].includes(le)) return "Mach-O executable header";
  return null;
}

/** Judge one file or member name. -> [{level, what}] */
export function nameFindings(name, where = "") {
  const out = [];
  const n = String(name || "");
  const base = n.split(/[\\/]/).pop();
  const ext = extOf(base);
  const at = where ? " (" + where + ")" : "";
  if (/[‮‭⁦⁧⁨]/.test(n)) out.push({ level: "danger", what: "right-to-left override in the name disguises its real extension" + at });
  const dbl = DECOY_EXT.exec(base);
  if (dbl && (EXEC_EXT.has(dbl[1].toLowerCase()) || SCRIPT_EXT.has(dbl[1].toLowerCase()))) out.push({ level: "danger", what: "double extension " + JSON.stringify(base) + ": looks like a document, is a ." + dbl[1].toLowerCase() + at });
  else if (EXEC_EXT.has(ext)) out.push({ level: "danger", what: "executable or shortcut type ." + ext + at });
  else if (SCRIPT_EXT.has(ext)) out.push({ level: "warn", what: "script (." + ext + "): read it before running it" + at });
  if (MACRO_EXT.has(ext)) out.push({ level: "danger", what: "Office macro-enabled document (." + ext + ")" + at });
  if (/(^|\/)vbaProject\.bin$/i.test(n)) out.push({ level: "danger", what: "Office macro project (vbaProject.bin)" + at });
  return out;
}

/** Minimal, bounded zip central-directory walk. -> { entries: [{name, method, csize, usize, local}], truncated, error } */
export function zipEntries(b, limits = ZIP_LIMITS) {
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b);
  // End of central directory: signature 0x06054b50 in the last 22 + 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return { entries: [], error: "no end-of-central-directory record" };
  let total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || total === 0xffff) return { entries: [], error: "zip64 archive (not walked)" };
  if (cdOff + cdSize > buf.length) return { entries: [], error: "central directory points outside the file" };
  const entries = [];
  let p = cdOff, truncated = false;
  for (let i = 0; i < total; i++) {
    if (entries.length >= limits.maxEntries) { truncated = true; break; }
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { entries, truncated, error: "corrupt central directory at entry " + i };
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nlen > buf.length) return { entries, truncated, error: "corrupt central directory name at entry " + i };
    const name = buf.subarray(p + 46, p + 46 + Math.min(nlen, 1024)).toString("utf8");
    entries.push({ name, method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return { entries, truncated };
}

/** First bytes of one member, bounded. null when it cannot be read cheaply. */
function memberHead(buf, e, limits) {
  const lo = e.local;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  if (start >= buf.length) return null;
  const slice = buf.subarray(start, Math.min(buf.length, start + Math.min(e.csize || limits.probeCompressedBytes, limits.probeCompressedBytes)));
  if (e.method === 0) return slice.subarray(0, 8);
  if (e.method === 8) {
    try { return inflateRawSync(slice, { finishFlush: zc.Z_SYNC_FLUSH }).subarray(0, 8); } catch { return null; }
  }
  return null;
}

/** Findings for a zip (or OOXML, jar, apk ...) archive. */
export function zipFindings(bytes, limits = ZIP_LIMITS) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const out = [];
  const z = zipEntries(buf, limits);
  if (z.error) out.push({ level: "warn", what: "archive could not be fully inspected: " + z.error });
  if (z.truncated) out.push({ level: "warn", what: "archive has more than " + limits.maxEntries + " entries; only the first " + limits.maxEntries + " were inspected" });
  let usum = 0, csum = 0, probes = 0, nested = 0;
  const seen = new Set();
  for (const e of z.entries) {
    usum += e.usize; csum += e.csize;
    for (const f of nameFindings(e.name, "in archive: " + e.name.slice(0, 120))) {
      const k = f.level + f.what; if (!seen.has(k)) { seen.add(k); out.push(f); }
    }
    if (/\.(?:zip|jar|apk|7z|rar|tar|gz|tgz|iso)$/i.test(e.name)) nested++;
    if (probes < limits.headerProbes && !e.name.endsWith("/") && e.usize > 0) {
      probes++;
      const h = memberHead(buf, e, limits);
      const kind = headerKind(h);
      if (kind) out.push({ level: "danger", what: kind + " inside the archive (" + e.name.slice(0, 120) + ")" });
    }
  }
  if (usum > limits.bombTotal || (csum > 0 && usum / csum > limits.bombRatio && usum > 50 * 1024 * 1024))
    out.push({ level: "danger", what: "decompression bomb: declares " + Math.round(usum / 1048576) + " MB uncompressed from " + Math.max(1, Math.round(csum / 1024)) + " KB" });
  if (nested) out.push({ level: "info", what: nested + " nested archive(s) inside: not walked" });
  return out;
}

const isZip = (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06);

export function inspectArtifact({ filename, bytes, declaredSha256, actualSha256 }) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const findings = [];
  const add = (level, what, detail) => findings.push({ level, what, ...(detail ? { detail } : {}) });

  if (declaredSha256 && actualSha256 && declaredSha256 !== actualSha256)
    add("danger", "sha256 mismatch: content differs from what the sender declared");

  const kind = headerKind(b.subarray(0, 8));
  if (kind) add("danger", kind);
  for (const f of nameFindings(filename)) add(f.level, f.what);
  if (isZip(b)) for (const f of zipFindings(b)) add(f.level, f.what);

  const verdict = findings.some((f) => f.level === "danger") ? "danger" : findings.some((f) => f.level === "warn") ? "warn" : "clean";
  return { verdict, findings, size: b.length, filename: filename || "file" };
}

/** Is this plausibly a text file (for the optional server-side text check)? UTF-8, no NUL in the first 8 KB. */
export function looksLikeText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.subarray(0, 8192).includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

export const safeName = (name) => String(name || "file").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 150) || "file";
