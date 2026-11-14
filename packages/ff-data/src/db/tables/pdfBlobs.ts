// src/core/db/tables/pdfBlobs.ts
//
// Binary store for raw PDF bytes. Mirrors `fragBlobs.ts` exactly:
// the row primary key is the same uuid stored on the corresponding
// PdfVersionRecord.blobKey, and the value is a Blob so Dexie can
// keep the bytes in IndexedDB without materializing them in memory.

import { db } from "../database";

/** Store or overwrite a raw PDF blob. */
export async function putPdfBlob(key: string, bytes: Blob): Promise<void> {
  await db.pdfBlobs.put({ key, bytes });
}

/** Retrieve a raw PDF blob. Returns null if the blob is missing.
 *  The `| null` return matches the @ff/viewer-react PdfOverlay contract
 *  (Promise<Blob | null>); the older `| undefined` form was a
 *  type-mismatch source after the Phase-1-lite extraction. */
export async function getPdfBlob(key: string): Promise<Blob | null> {
  const row = await db.pdfBlobs.get(key);
  return row?.bytes ?? null;
}

/** Delete a raw PDF blob. */
export async function deletePdfBlob(key: string): Promise<void> {
  await db.pdfBlobs.delete(key);
}

/** All PDF blob keys currently stored. */
export async function listPdfBlobKeys(): Promise<string[]> {
  const rows = await db.pdfBlobs.toArray();
  return rows.map((r) => r.key);
}
