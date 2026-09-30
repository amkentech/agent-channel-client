// Minimal DER (ASN.1 Distinguished Encoding Rules) reader and writer: exactly what RFC 3161 timestamp requests,
// responses and their CMS SignedData tokens need, and nothing else. No dependency on purpose: a verifier that a bank
// auditor runs offline should be readable end to end, and pkijs/asn1js would add ~1 MB of code for four structures.
// Strict: indefinite lengths (BER, not DER) and truncated input throw rather than being guessed at.

/** parse(buf, offset?) -> node { tag, cls, constructed, num, start, hlen, len, end, raw, value, children? } */
export function parse(buf, offset = 0, end = buf.length) {
  if (offset + 2 > end) throw new Error("DER: truncated at " + offset);
  const tag = buf[offset];
  let p = offset + 1;
  let num = tag & 0x1f;
  if (num === 0x1f) { // high tag number form
    num = 0;
    let b;
    do { if (p >= end) throw new Error("DER: truncated tag"); b = buf[p++]; num = num * 128 + (b & 0x7f); } while (b & 0x80);
  }
  if (p >= end) throw new Error("DER: truncated length");
  let len = buf[p++];
  if (len === 0x80) throw new Error("DER: indefinite length is not DER");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || p + n > end) throw new Error("DER: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++];
  }
  const hlen = p - offset;
  if (p + len > end) throw new Error("DER: content overruns its container at " + offset);
  const node = {
    tag, cls: tag >> 6, constructed: !!(tag & 0x20), num, start: offset, hlen, len, end: p + len,
    raw: buf.subarray(offset, p + len), value: buf.subarray(p, p + len),
  };
  if (node.constructed) {
    node.children = [];
    let q = p;
    while (q < p + len) { const c = parse(buf, q, p + len); node.children.push(c); q = c.end; }
  }
  return node;
}

/** parse and require the whole buffer to be one element. */
export function parseAll(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const n = parse(b, 0, b.length);
  if (n.end !== b.length) throw new Error("DER: trailing bytes after the top-level element");
  return n;
}

export const isCtx = (n, k) => n && n.cls === 2 && n.num === k;

export function oid(n) {
  if (!n || n.tag !== 0x06) throw new Error("DER: expected OBJECT IDENTIFIER");
  const v = n.value, out = [];
  let x = 0;
  for (let i = 0; i < v.length; i++) {
    x = x * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      if (!out.length) { const a = x < 40 ? 0 : x < 80 ? 1 : 2; out.push(a, x - a * 40); } else out.push(x);
      x = 0;
    }
  }
  return out.join(".");
}

/** INTEGER as a BigInt (two's complement). */
export function int(n) {
  if (!n || n.tag !== 0x02) throw new Error("DER: expected INTEGER");
  let x = 0n;
  for (const b of n.value) x = (x << 8n) | BigInt(b);
  if (n.value.length && n.value[0] & 0x80) x -= 1n << BigInt(8 * n.value.length);
  return x;
}

/** GeneralizedTime / UTCTime -> Date. Fractional seconds kept to the millisecond. */
export function time(n) {
  const s = n.value.toString("latin1");
  if (n.tag === 0x18) {
    const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:[.,](\d+))?Z$/);
    if (!m) throw new Error("DER: GeneralizedTime not in UTC form: " + s);
    const ms = m[7] ? Number((m[7] + "000").slice(0, 3)) : 0;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms));
  }
  if (n.tag === 0x17) {
    const m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (!m) throw new Error("DER: bad UTCTime " + s);
    const y = +m[1] < 50 ? 2000 + +m[1] : 1900 + +m[1];
    return new Date(Date.UTC(y, +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  }
  throw new Error("DER: expected a time");
}

// ---------- writer ----------
function lenBytes(n) {
  if (n < 0x80) return Buffer.from([n]);
  const out = [];
  while (n > 0) { out.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | out.length, ...out]);
}
export const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), lenBytes(content.length), content]);
export const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
export const set = (...parts) => tlv(0x31, Buffer.concat(parts));
export const octets = (b) => tlv(0x04, Buffer.from(b));
export const nul = () => Buffer.from([0x05, 0x00]);
export const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
export function integer(v) {
  let x = BigInt(v);
  if (x < 0n) throw new Error("DER: negative integers are not needed here");
  const bytes = [];
  do { bytes.unshift(Number(x & 0xffn)); x >>= 8n; } while (x > 0n);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return tlv(0x02, Buffer.from(bytes));
}
/** INTEGER from raw unsigned big-endian bytes (a nonce). */
export function integerBytes(b) {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const v = Buffer.from(b.subarray(i));
  return tlv(0x02, v[0] & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
}
export function objectId(dotted) {
  const p = dotted.split(".").map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const x of p.slice(2)) {
    const b = [x & 0x7f];
    let y = Math.floor(x / 128);
    while (y > 0) { b.unshift(0x80 | (y & 0x7f)); y = Math.floor(y / 128); }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
