/** Deterministic GUIDs: UUID v5 (SHA-1, name-based) with a fixed FreeField namespace. */

/** Fixed FreeField namespace for BCF GUIDs. Never change: it keeps exports stable. */
export const FREEFIELD_BCF_NAMESPACE = '6f1d3c2e-5a47-4b8e-9c0d-3e7a1b2c4d5f';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** Synchronous SHA-1 of a byte array. */
export function sha1(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000), false);
  dv.setUint32(total - 4, (len * 8) >>> 0, false);
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rol = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + (f >>> 0) + e + k + w[i]!) >>> 0;
      e = d; d = c; c = rol(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => odv.setUint32(i * 4, h, false));
  return out;
}

function uuidToBytes(u: string): Uint8Array {
  const hex = u.replace(/-/g, '');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToUuid(b: Uint8Array): string {
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** UUID v5 of `name` in `namespace` (lowercase). */
export function uuidv5(name: string, namespace: string = FREEFIELD_BCF_NAMESPACE): string {
  const nsBytes = uuidToBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes);
  input.set(nameBytes, nsBytes.length);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return bytesToUuid(hash);
}

/** The id itself (lowercased) for kind task/entry when it is a UUID, otherwise `uuidv5(kind:id)`. */
export function guidFor(kind: string, id: string): string {
  // Only topics and comments keep a UUID id verbatim; every other kind is derived so GUIDs never collide.
  if ((kind === 'task' || kind === 'entry') && isUuid(id)) return id.toLowerCase();
  return uuidv5(`${kind}:${id}`);
}
