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
import { uuid } from "@ff/data/db/uuid";
import { toStorageError } from "@ff/data/db/errors";
import { findPdfFileByName } from "@ff/data/db/tables/pdfFiles";
import {
  createPdfVersion,
  getLatestPdfVersion,
  listPdfVersions,
  setPdfVersionAsLatest,
} from "@ff/data/db/tables/pdfVersions";
import { putPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { validatePDFBuffer, loadPDF } from "@ff/viewer";
import type {
  PdfFileRecord,
  PdfVersionRecord,
} from "@ff/types";

/** Result of a successful loadPdf call. */
export interface LoadPdfResult {
  pdfFileId: string;
  versionId: string;
  versionNumber: number;
  isNewFile: boolean;
}

/**
 * State surfaced to the sidebar (and the future <PdfUploadError>
 * banner, if one is added). Mirrors the IFC pipeline shape.
 */
export interface UsePdfPipelineResult {
  loadPdf: (file: File, buildingId: string) => Promise<LoadPdfResult>;
  replacePdfVersion: (pdfFileId: string, file: File) => Promise<LoadPdfResult>;
  deletePdf: (pdfFileId: string) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
}

const HASH_HEAD_BYTES = 64 * 1024;

/**
 * Same fingerprint as `computeContentHash(file)` (SHA-256 of the first
 * 64 KiB + the size as an 8-byte big-endian suffix), computed from the
 * bytes we already read instead of reading the File a second time.
 */
export async function contentHashFromBuffer(buffer: ArrayBuffer): Promise<string> {
  const size = buffer.byteLength;
  const head = new Uint8Array(buffer, 0, Math.min(HASH_HEAD_BYTES, size));
  const sizeBytes = new Uint8Array(8);
  const high = Math.floor(size / 0x1_0000_0000);
  const low = size >>> 0;
  sizeBytes[0] = (high >>> 24) & 0xff;
  sizeBytes[1] = (high >>> 16) & 0xff;
  sizeBytes[2] = (high >>> 8) & 0xff;
  sizeBytes[3] = high & 0xff;
  sizeBytes[4] = (low >>> 24) & 0xff;
  sizeBytes[5] = (low >>> 16) & 0xff;
  sizeBytes[6] = (low >>> 8) & 0xff;
  sizeBytes[7] = low & 0xff;
  const combined = new Uint8Array(head.length + 8);
  combined.set(head, 0);
  combined.set(sizeBytes, head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", combined));
  let out = "";
  for (let i = 0; i < digest.length; i++) out += digest[i].toString(16).padStart(2, "0");
  return out;
}

/** What a parsed PDF contributes to its version row. */
interface ParsedPdf {
  name: string;
  size: number;
  contentHash: string;
  pageCount: number;
  width: number;
  height: number;
}

/**
 * Read, validate, fingerprint and measure a PDF. The PDF.js document
 * is always destroyed (`finally`), also when measuring throws.
 * Multi-page PDFs are accepted; page 1 gives the page size.
 */
async function parsePdfFile(file: File): Promise<ParsedPdf> {
  const buffer = await file.arrayBuffer();
  // validatePDFBuffer runs inside loadPDF too, but we also want a
  // clean error path for "file too small" / "magic bytes missing"
  // that doesn't require the PDF.js worker to be configured.
  validatePDFBuffer(buffer);
  // Hash first: the bytes handed to PDF.js may be transferred.
  const contentHash = await contentHashFromBuffer(buffer);
  const api = await loadPDF(new Uint8Array(buffer), { singlePage: false });
  try {
    return {
      name: file.name,
      size: file.size,
      contentHash,
      pageCount: api.numPages,
      width: api.width,
      height: api.height,
    };
  } finally {
    api.destroy();
  }
}

/**
 * Insert a new latest version for `pdfFileId` inside the caller's
 * transaction: the next version number is read in the same rw
 * transaction as the insert, so two concurrent uploads can't both
 * become "v2".
 */
async function insertLatestVersion(
  pdfFileId: string,
  parsed: ParsedPdf,
  file: File,
): Promise<PdfVersionRecord> {
  const latest = await getLatestPdfVersion(pdfFileId);
  const blobKey = uuid();
  await putPdfBlob(blobKey, file);
  const row = await createPdfVersion({
    pdfFileId,
    versionNumber: (latest?.versionNumber ?? 0) + 1,
    name: parsed.name,
    size: parsed.size,
    contentHash: parsed.contentHash,
    pageCount: parsed.pageCount,
    width: parsed.width,
    height: parsed.height,
    blobKey,
    isLatest: true,
  });
  const siblings = await listPdfVersions(pdfFileId);
  for (const s of siblings) {
    if (s.id !== row.id && s.isLatest) {
      await db.pdfVersions.update(s.id, { isLatest: false });
    }
  }
  await setPdfVersionAsLatest(row.id);
  return row;
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
        // Parse + fingerprint before opening a transaction. If this
        // throws (corrupt, oversized) the Dexie write never starts.
        const parsed = await parsePdfFile(file);

        // Version-key lookup and writes in ONE rw transaction: same
        // (buildingId, name) → new version; new pair → new file row.
        // A failure rolls back the blob, file and version rows together.
        return await db.transaction(
          "rw",
          [db.pdfFiles, db.pdfVersions, db.pdfBlobs],
          async () => {
            const existing = await findPdfFileByName(buildingId, file.name);
            let pdfFile: PdfFileRecord;
            if (existing) {
              pdfFile = existing;
              await db.pdfFiles.update(existing.id, { updatedAt: Date.now() });
            } else {
              pdfFile = {
                id: uuid(),
                buildingId,
                name: file.name,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              await db.pdfFiles.add(pdfFile);
            }
            const row = await insertLatestVersion(pdfFile.id, parsed, file);
            return {
              pdfFileId: pdfFile.id,
              versionId: row.id,
              versionNumber: row.versionNumber,
              isNewFile: !existing,
            };
          },
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

  const replacePdfVersion = useCallback(
    async (pdfFileId: string, file: File): Promise<LoadPdfResult> => {
      setIsLoading(true);
      setError(null);
      try {
        if (!(await db.pdfFiles.get(pdfFileId))) {
          throw new Error(`PdfFileRecord not found: ${pdfFileId}`);
        }
        const parsed = await parsePdfFile(file);
        return await db.transaction(
          "rw",
          [db.pdfVersions, db.pdfBlobs, db.pdfFiles],
          async () => {
            if (!(await db.pdfFiles.get(pdfFileId))) {
              throw new Error(`PdfFileRecord not found: ${pdfFileId}`);
            }
            const row = await insertLatestVersion(pdfFileId, parsed, file);
            await db.pdfFiles.update(pdfFileId, { updatedAt: Date.now() });
            return {
              pdfFileId,
              versionId: row.id,
              versionNumber: row.versionNumber,
              isNewFile: false,
            };
          },
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

  return { loadPdf, replacePdfVersion, deletePdf, isLoading, error };
}
