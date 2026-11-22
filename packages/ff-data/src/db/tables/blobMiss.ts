// src/db/tables/blobMiss.ts
//
// Phase 1d seam: when a local blob read misses, the sync engine (which
// @ff/data cannot import) may download it from Storage. The engine
// registers one handler; readers call `runBlobMissHandler`.

export type BlobMissKind = "frag" | "pdf";
/** Resolve true when the blob is now present in the local table. */
export type BlobMissHandler = (kind: BlobMissKind, key: string) => Promise<boolean>;

let handler: BlobMissHandler | null = null;

/** Register (or clear with null) the lazy-download handler. Returns the previous one. */
export function setBlobMissHandler(next: BlobMissHandler | null): BlobMissHandler | null {
  const prev = handler;
  handler = next;
  return prev;
}

export async function runBlobMissHandler(kind: BlobMissKind, key: string): Promise<boolean> {
  if (!handler) return false;
  try {
    return await handler(kind, key);
  } catch {
    return false;
  }
}
