// src/core/db/files/hash.ts
//
// SHA-256 content fingerprints.
//
// - computeFullContentHash(bytes): SHA-256 over EVERY byte. This is
//   what IFC dedupe uses (since wave 63): the IFC import worker
//   already holds the whole file in memory for web-ifc, so it hashes
//   the full bytes there (native SubtleCrypto, off the main thread)
//   and reports the digest before converting. Two different models
//   that share a header and a size can no longer be mistaken for the
//   same version.
// - computeContentHash(file): the older cheap fingerprint, SHA-256 of
//   (first 64KB || file-size as 8-byte big-endian). Still used by the
//   PDF pipeline. NOT safe for dedupe of large files whose edits land
//   after the first 64 KB with the same size.

const HEAD_BYTES = 64 * 1024; // 64 KiB

/**
 * Compute a hex SHA-256 content hash from the first 64KB of a File plus
 * the file size encoded as an 8-byte big-endian suffix. Returns the
 * lowercase hex digest (64 chars).
 */
export async function computeContentHash(file: File): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "SubtleCrypto is not available in this environment; cannot hash files.",
    );
  }

  const headSize = Math.min(HEAD_BYTES, file.size);
  const head = new Uint8Array(headSize);
  if (headSize > 0) {
    const headBlob = file.slice(0, headSize);
    const headBuf = await headBlob.arrayBuffer();
    head.set(new Uint8Array(headBuf));
  }

  // 8-byte big-endian size suffix.
  const sizeBytes = new Uint8Array(8);
  // File.size is a JS number; clamp to safe integer range.
  const size = Number.isFinite(file.size) ? Math.max(0, Math.floor(file.size)) : 0;
  // We split into high/low 32-bit halves to stay within JS safe int range.
  const high = Math.floor(size / 0x1_0000_0000);
  const low = size >>> 0;
  // Write big-endian manually (DataView would also work but avoids the view).
  sizeBytes[0] = (high >>> 24) & 0xff;
  sizeBytes[1] = (high >>> 16) & 0xff;
  sizeBytes[2] = (high >>> 8) & 0xff;
  sizeBytes[3] = high & 0xff;
  sizeBytes[4] = (low >>> 24) & 0xff;
  sizeBytes[5] = (low >>> 16) & 0xff;
  sizeBytes[6] = (low >>> 8) & 0xff;
  sizeBytes[7] = low & 0xff;

  const combined = new Uint8Array(head.length + sizeBytes.length);
  combined.set(head, 0);
  combined.set(sizeBytes, head.length);

  const digest = await crypto.subtle.digest("SHA-256", combined);
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Full-file SHA-256 of `bytes`, lowercase hex (64 chars). Runs
 * wherever it is called — the IFC import worker in the app.
 */
export async function computeFullContentHash(
  bytes: Uint8Array | ArrayBuffer,
): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error(
      "SubtleCrypto is not available in this environment; cannot hash files.",
    );
  }
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view as BufferSource);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
