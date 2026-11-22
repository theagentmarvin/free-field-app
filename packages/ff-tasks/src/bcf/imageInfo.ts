/** Pure PNG / JPEG dimension readers (no decoding). */

export interface ImageSize {
  width: number;
  height: number;
}

export function readImageSize(bytes: Uint8Array): ImageSize | null {
  return readPngSize(bytes) ?? readJpegSize(bytes);
}

export function readPngSize(b: Uint8Array): ImageSize | null {
  if (b.length < 24) return null;
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) return null;
  // IHDR chunk type at 12..16
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const width = dv.getUint32(16, false);
  const height = dv.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function readJpegSize(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    let marker = b[i + 1]!;
    while (marker === 0xff && i + 2 < b.length) { i++; marker = b[i + 1]!; }
    i += 2;
    // Standalone markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > b.length) return null;
    const segLen = (b[i]! << 8) | b[i + 1]!;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (i + 7 > b.length) return null;
      const height = (b[i + 3]! << 8) | b[i + 4]!;
      const width = (b[i + 5]! << 8) | b[i + 6]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (segLen < 2) return null;
    i += segLen;
  }
  return null;
}
