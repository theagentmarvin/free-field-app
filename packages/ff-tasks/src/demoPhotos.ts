/**
 * Procedural PNG generation for seeded demo photos — real, renderable
 * PNG data URLs built in-memory (no binary files committed to the repo).
 * The PNG encoder emits an RGBA image using zlib "stored" (uncompressed)
 * deflate blocks, which keeps the implementation dependency-free and tiny
 * enough to fit the ~100px thumbs the demo shows.
 */

type Rgb = [number, number, number];

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): number[] {
  const out: number[] = [];
  out.push(...u32(data.length));
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  out.push(...typeBytes, ...data);
  out.push(...u32(crc32(new Uint8Array([...typeBytes, ...data]))));
  return out;
}

/** Build a valid RGBA PNG data URL from a per-pixel color closure. */
export function pngDataUrl(
  width: number,
  height: number,
  colorAt: (x: number, y: number) => Rgb,
): string {
  const raw: number[] = [];
  for (let y = 0; y < height; y++) {
    raw.push(0); // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colorAt(x, y);
      raw.push(r, g, b, 255);
    }
  }
  const rawBytes = new Uint8Array(raw);

  // zlib header + stored (uncompressed) deflate blocks.
  const zlib: number[] = [0x78, 0x01];
  const MAX = 65535;
  let offset = 0;
  while (offset < rawBytes.length) {
    const len = Math.min(MAX, rawBytes.length - offset);
    const final = offset + len >= rawBytes.length ? 1 : 0;
    zlib.push(final);
    zlib.push(len & 255, (len >>> 8) & 255);
    zlib.push(~len & 255, (~len >>> 8) & 255);
    for (let i = 0; i < len; i++) zlib.push(rawBytes[offset + i]);
    offset += len;
  }
  const idat = new Uint8Array([...zlib, ...u32(adler32(rawBytes))]);

  const ihdr = new Uint8Array([
    ...u32(width),
    ...u32(height),
    8, // bit depth
    6, // color type RGBA
    0, // compression
    0, // filter
    0, // interlace
  ]);

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const bytes = [
    ...signature,
    ...pngChunk('IHDR', ihdr),
    ...pngChunk('IDAT', idat),
    ...pngChunk('IEND', new Uint8Array()),
  ];
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/png;base64,${globalThis.btoa(bin)}`;
}

/** A small deterministic "photo" for a given palette index — a two-tone
 *  vertical split with a lighter bottom band, enough to read as a site
 *  photo at thumb size. */
export function demoPhotoDataUrl(index: number): string {
  const palette: Rgb[] = [
    [196, 168, 128],
    [150, 178, 198],
    [168, 196, 156],
    [210, 190, 168],
    [160, 160, 176],
    [184, 160, 128],
  ];
  const [r, g, b] = palette[index % palette.length];
  return pngDataUrl(64, 48, (x, y) => {
    if (y > 32) {
      return [Math.min(255, r + 26), Math.min(255, g + 26), Math.min(255, b + 26)];
    }
    // subtle horizontal gradient for texture
    const t = x / 64;
    return [
      Math.round(r * (1 - t * 0.15)),
      Math.round(g * (1 - t * 0.15)),
      Math.round(b * (1 - t * 0.15)),
    ];
  });
}