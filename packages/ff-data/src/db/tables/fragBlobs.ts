// src/core/db/tables/fragBlobs.ts
import { db } from "../database";

/** Store or overwrite a frag binary blob. */
export async function putFragBlob(key: string, blob: Blob): Promise<void> {
  await db.fragBlobs.put({ key, blob });
}

/** Retrieve a frag binary blob. Returns null if the blob is missing.
 *  The `| null` return matches the @ff/viewer-react contract
 *  (Promise<Blob | null>); the older `| undefined` form was a
 *  type-mismatch source after the Phase-1-lite extraction. */
export async function getFragBlob(key: string): Promise<Blob | null> {
  const row = await db.fragBlobs.get(key);
  return row?.blob ?? null;
}

/** Delete a frag binary blob. */
export async function deleteFragBlob(key: string): Promise<void> {
  await db.fragBlobs.delete(key);
}

/** All frag blob keys currently stored. */
export async function listFragBlobKeys(): Promise<string[]> {
  const rows = await db.fragBlobs.toArray();
  return rows.map((r) => r.key);
}
