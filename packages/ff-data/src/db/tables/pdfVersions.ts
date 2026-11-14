// src/core/db/tables/pdfVersions.ts
//
// CRUD for `pdfVersions` — the version chain. Mirrors
// `ifcVersions.ts` exactly: same `isLatest` invariant, same
// `setAsLatest` toggle pattern, same delete-cascade shape (minus the
// storeys + extractedStoreys tables — PDFs have no such downstream
// rows in Step 1).
//
// See docs/TASK-11-PDF-CANVAS.md "CRUD tables" for the contract.

import { db } from "../database";
import { uuid } from "../uuid";
import type { PdfVersionRecord } from "@ff/types";

export type CreatePdfVersionInput = Omit<
  PdfVersionRecord,
  "id" | "storedAt"
> &
  Partial<Pick<PdfVersionRecord, "id" | "storedAt">>;

/**
 * Insert a new PdfVersionRecord. Caller is responsible for keeping
 * the "exactly one latest per pdfFileId" invariant; use `setAsLatest`
 * for that. The blob it points at is written separately via
 * `putPdfBlob` (key = input.blobKey).
 */
export async function createPdfVersion(
  input: CreatePdfVersionInput,
): Promise<PdfVersionRecord> {
  const record: PdfVersionRecord = {
    id: input.id ?? uuid(),
    pdfFileId: input.pdfFileId,
    versionNumber: input.versionNumber,
    name: input.name,
    size: input.size,
    contentHash: input.contentHash,
    pageCount: input.pageCount,
    width: input.width,
    height: input.height,
    storedAt: input.storedAt ?? Date.now(),
    blobKey: input.blobKey,
    isLatest: input.isLatest,
  };
  await db.pdfVersions.add(record);
  return record;
}

/** Look up a PdfVersionRecord by id. Returns null if missing.
 *  The `| null` return matches the @ff/viewer-react PdfOverlay contract
 *  (Promise<{ blobKey, width, height } | null>); the older
 *  `| undefined` form was a type-mismatch source after the
 *  Phase-1-lite extraction. */
export async function getPdfVersion(
  id: string,
): Promise<PdfVersionRecord | null> {
  const row = await db.pdfVersions.get(id);
  return row ?? null;
}

export async function listPdfVersions(
  pdfFileId: string,
): Promise<PdfVersionRecord[]> {
  return db.pdfVersions
    .where("pdfFileId")
    .equals(pdfFileId)
    .sortBy("versionNumber");
}

export async function getLatestPdfVersion(
  pdfFileId: string,
): Promise<PdfVersionRecord | undefined> {
  const all = await db.pdfVersions
    .where("pdfFileId")
    .equals(pdfFileId)
    .toArray();
  return all.find((v) => v.isLatest);
}

/**
 * Atomically (within one Dexie transaction) mark `versionId` as the
 * latest for its pdfFileId and clear the flag on the previous
 * latest. PDF has no parent-pointer field to update (the file row
 * is content-less — `name` + `buildingId` are the identity), so the
 * work here is lighter than the IFC equivalent.
 */
export async function setPdfVersionAsLatest(
  versionId: string,
): Promise<void> {
  await db.transaction("rw", db.pdfVersions, async () => {
    const target = await db.pdfVersions.get(versionId);
    if (!target) throw new Error(`PdfVersionRecord not found: ${versionId}`);

    const siblings = await db.pdfVersions
      .where("pdfFileId")
      .equals(target.pdfFileId)
      .toArray();
    for (const s of siblings) {
      if (s.id === versionId) continue;
      if (s.isLatest) {
        await db.pdfVersions.update(s.id, { isLatest: false });
      }
    }
    if (!target.isLatest) {
      await db.pdfVersions.update(versionId, { isLatest: true });
    }
  });
}

/**
 * Delete a single PDF version. Cascades to its blob. If the deleted
 * version was the latest, promotes the previous version (by
 * versionNumber desc) to latest. If no versions remain, the parent
 * file row is left alone (the pipeline layer's
 * `deletePdfFile` handles empty-chains).
 */
export async function deletePdfVersion(id: string): Promise<void> {
  const version = await db.pdfVersions.get(id);
  if (!version) return;

  await db.transaction("rw", [db.pdfVersions, db.pdfBlobs], async () => {
    // Delete the blob.
    await db.pdfBlobs.delete(version.blobKey);
    // Delete the version itself.
    await db.pdfVersions.delete(id);

    // Re-point the latest flag if needed.
    if (version.isLatest) {
      const remaining = await db.pdfVersions
        .where("pdfFileId")
        .equals(version.pdfFileId)
        .toArray();
      const next = remaining.sort(
        (a, b) => b.versionNumber - a.versionNumber,
      )[0];
      if (next) {
        await db.pdfVersions.update(next.id, { isLatest: true });
      }
    }
  });
}
