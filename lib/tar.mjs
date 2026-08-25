// Minimal ustar writer/reader, enough to carry a directory of artifacts as one blob (publish <dir> gzips the result).
// No dependency: the client must stay auditable in one sitting. Regular files only; paths are stored with forward
// slashes; names longer than 100 bytes use the ustar prefix field (up to 155+100). Anything longer is refused loudly.
const enc = new TextEncoder();

const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";

function header(path, size, mtime) {
  const b = new Uint8Array(512);
  const put = (s, off, len) => { const u = enc.encode(s); if (u.length > len) throw new Error("tar field overflow: " + s); b.set(u, off); };
  let name = path, prefix = "";
  if (enc.encode(name).length > 100) {
    const i = path.slice(0, 155).lastIndexOf("/");
    if (i < 1 || enc.encode(path.slice(i + 1)).length > 100) throw new Error("path too long for tar: " + path);
    prefix = path.slice(0, i); name = path.slice(i + 1);
  }
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);            // mode
  put(octal(0, 8), 108, 8);                // uid
  put(octal(0, 8), 116, 8);                // gid
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor((mtime ?? Date.now()) / 1000), 12), 136, 12);
  b.set(enc.encode("        "), 148);      // checksum placeholder: spaces
  b[156] = 0x30;                           // typeflag '0' regular file
  put("ustar\0", 257, 6); put("00", 263, 2);
  if (prefix) put(prefix, 345, 155);
  let sum = 0; for (const x of b) sum += x;
  b.set(enc.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  return b;
}

/** files: [{path, data: Uint8Array|Buffer, mtime?}] -> Uint8Array (uncompressed tar) */
export function tarCreate(files) {
  const parts = [];
  for (const f of files) {
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
    parts.push(header(String(f.path).replace(/\\/g, "/"), data.length, f.mtime));
    parts.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024)); // two zero blocks: end of archive
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Uint8Array (uncompressed tar) -> [{path, data: Uint8Array}], regular files only. */
export function tarList(buf) {
  const dec = new TextDecoder();
  const str = (off, len) => { const s = buf.subarray(off, off + len); const z = s.indexOf(0); return dec.decode(z >= 0 ? s.subarray(0, z) : s); };
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((x) => x === 0)) break;
    const size = parseInt(str(off + 124, 12).trim() || "0", 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 0x30);
    const prefix = str(off + 345, 155);
    const name = (prefix ? prefix + "/" : "") + str(off, 100);
    if (type === "0" || type === "\0") files.push({ path: name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
