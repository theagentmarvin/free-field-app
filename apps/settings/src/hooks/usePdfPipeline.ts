// src/hooks/usePdfPipeline.ts
//
// React hook wrapping the PDF upload + replace + delete pipeline.
// Mirrors the shape of `useIfcPipeline.ts` but skips the heavy
// steps (WASM parsing, OBC frag generation). For PDFs the work
// is:
//
//   1. Read the File as ArrayBuffer.
//   2. validatePDFBuffer + loadPDF (multi-page accepted; page 1 sizes).
//   3. Capture page size in PDF points (width / height) for the
//      PdfVersionRecord so the viewer can skip a re-load just to
//      learn the size.
//   4. contentHashFromBuffer() fingerprints the bytes already read
//      (same scheme as computeContentHash()).
//   5. Look up PdfFileRecord by (buildingId, name):
//        - existing file → new PdfVersionRecord
//          (versionNumber+1, latest=true), previous latest
//          flipped to isLatest=false.
//        - no file yet → new PdfFileRecord + new
//          PdfVersionRecord (v1) in the same transaction.
//   6. Persist raw PDF bytes to `pdfBlobs` keyed by blobKey.
//   7. Return { pdfFileId, versionId, versionNumber, isNewFile }
//      so the caller can auto-open the canvas (sets
//      `activePdfVersionId` in the viewer store).
//
// `deletePdf(pdfFileId)` and `replacePdfVersion(pdfFileId, file)`
// mirror the IFC versions. There is no FragmentsManager
// integration to worry about — the PDF canvas is created on
// demand when the user clicks a row.

import { useCallback, useEffect, useState } from "react";

import { db } from "@ff/data/db/database";
import { toStorageError } from "@ff/data/db/errors";
import {
  contentHashFromBuffer,
  importPdfFile,
  replacePdfFile,
  type LoadPdfResult,
} from "./pdfImport";

export { contentHashFromBuffer };
export type { LoadPdfResult };

/**
 * State surfaced to the sidebar (and the future <PdfUploadError>
 * banner, if one is added). Mirrors the IFC pipeline shape.
 */
export interface UsePdfPipelineResult {
  loadPdf: (file: File, buildingId: string) => Promise<LoadPdfResult>;
  replacePdfVersion: (pdfFileId: string, file: File) => Promise<LoadPdfResult>;
  /** Bulk upload (sequential); never throws — see `BulkPdfResult`. */
  loadPdfs: (
    files: readonly File[],
    buildingId: string,
    onProgress?: (index: number, total: number, name: string) => void,
  ) => Promise<BulkPdfResult>;
  deletePdf: (pdfFileId: string) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

/** Outcome of a bulk upload. */
export interface BulkPdfResult {
  imported: LoadPdfResult[];
  failed: { name: string; error: Error }[];
}

/**
 * The `deletePdfFile` cascade (versions + blobs, calibrations, folder
 * assignment, file row) as plain table operations, for use inside ONE
 * rw transaction. `deletePdfFile` itself can't run in a transaction:
 * it awaits dynamic `import()`s, which commit the IndexedDB
 * transaction early (Dexie PrematureCommitError). Keep in sync with
 * `@ff/data` `deletePdfFile` until that function is made atomic.
 */
async function deletePdfCascade(pdfFileId: string): Promise<void> {
  const versions = await db.pdfVersions.where("pdfFileId").equals(pdfFileId).toArray();
  await db.pdfBlobs.bulkDelete(versions.map((v) => v.blobKey));
  await db.pdfVersions.bulkDelete(versions.map((v) => v.id));
  await db.calibrations.where("pdfFileId").equals(pdfFileId).delete();
  await db.pdfFolderAssignments.where("pdfFileId").equals(pdfFileId).delete();
  await db.pdfFiles.delete(pdfFileId);
}

/**
 * Wave 64 — a full browser storage quota (however Dexie wrapped it)
 * becomes a `StorageQuotaExceededError` the UI shows as "Browser
 * storage is full".
 */
function asError(e: unknown): Error {
  const mapped = toStorageError(e);
  return mapped instanceof Error ? mapped : new Error(String(mapped));
}

export function usePdfPipeline(): UsePdfPipelineResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadPdf = useCallback(
    async (file: File, buildingId: string): Promise<LoadPdfResult> => {
      setIsLoading(true);
      setError(null);
      try {
        return await importPdfFile(file, buildingId);
      } catch (e) {
        const err = asError(e);
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const replacePdfVersion = useCallback(
    async (pdfFileId: string, file: File): Promise<LoadPdfResult> => {
      setIsLoading(true);
      setError(null);
      try {
        return await replacePdfFile(pdfFileId, file);
      } catch (e) {
        const err = asError(e);
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const deletePdf = useCallback(
    async (pdfFileId: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      try {
        // The whole cascade (versions + blobs, calibrations, folder
        // assignment, file row) in ONE rw transaction: a failure
        // part-way leaves nothing half-deleted.
        await db.transaction(
          "rw",
          [
            db.pdfFiles,
            db.pdfVersions,
            db.pdfBlobs,
            db.calibrations,
            db.pdfFolderAssignments,
          ],
          () => deletePdfCascade(pdfFileId),
        );
      } catch (e) {
        const err = asError(e);
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  // Auto-clear transient errors after 5s so they don't pin the
  // UI. Same pattern as the IFC pipeline.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  /**
   * 2026-11-16 — upload several PDFs in one go. Files import ONE AT A
   * TIME (bounded memory, one Dexie transaction each); a bad file never
   * stops the batch. `onProgress(i, total, name)` fires before each.
   */
  const loadPdfs = useCallback(
    async (
      files: readonly File[],
      buildingId: string,
      onProgress?: (index: number, total: number, name: string) => void,
    ): Promise<BulkPdfResult> => {
      const result: BulkPdfResult = { imported: [], failed: [] };
      for (let i = 0; i < files.length; i += 1) {
        const f = files[i]!;
        onProgress?.(i, files.length, f.name);
        try {
          result.imported.push(await loadPdf(f, buildingId));
        } catch (e) {
          result.failed.push({ name: f.name, error: asError(e) });
        }
      }
      // The per-file error state shows the last failure; the batch
      // summary (returned) reports every failure.
      return result;
    },
    [loadPdf],
  );

  return { loadPdf, loadPdfs, replacePdfVersion, deletePdf, isLoading, error };
}
