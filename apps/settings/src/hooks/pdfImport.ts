// src/hooks/pdfImport.ts
//
// Pure (non-React) PDF import core shared by `usePdfPipeline` and the
// FreeField bundle importer. Parse + fingerprint a PDF, then write the
// file / version / blob rows in ONE Dexie transaction:
//   - same (buildingId, name)  -> new version (latest flag flipped)
//   - new pair                 -> new file row + version 1
// A mapped plan refuses a multi-page replacement.

import { MappedPlanMultiPageError } from "@ff/data";

import { db } from "@ff/data/db/database";
import { uuid } from "@ff/data/db/uuid";
import { findPdfFileByName } from "@ff/data/db/tables/pdfFiles";
import {
  createPdfVersion,
  getLatestPdfVersion,
  listPdfVersions,
  setPdfVersionAsLatest,
} from "@ff/data/db/tables/pdfVersions";
import { putPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { validatePDFBuffer, loadPDF } from "@ff/viewer";

/** Pre-read size gate; mirrors `MAX_PDF_SIZE` in @ff/viewer (50 MB, enforced again by validatePDFBuffer). */
const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;
import type { PdfFileRecord, PdfVersionRecord } from "@ff/types";

/** Result of a successful import / replace. */
export interface LoadPdfResult {
  pdfFileId: string;
  versionId: string;
  versionNumber: number;
  isNewFile: boolean;
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
/**
 * SHA-256 over the WHOLE content (hex). The default fingerprint only covers
 * the first 64 KiB + the size, which misses same-size edits further in.
 */
export async function fullContentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let out = "full:";
  for (let i = 0; i < digest.length; i++) out += digest[i]!.toString(16).padStart(2, "0");
  return out;
}

export interface ParsedPdf {
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
export async function parsePdfFile(
  file: File,
  opts: { contentHash?: string } = {},
): Promise<ParsedPdf> {
  // Reject oversized files from the File metadata, before reading any bytes.
  if (file.size > MAX_PDF_FILE_BYTES) {
    throw new Error(
      `PDF exceeds ${MAX_PDF_FILE_BYTES / 1024 / 1024} MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB received)`,
    );
  }
  const buffer = await file.arrayBuffer();
  // validatePDFBuffer runs inside loadPDF too, but we also want a
  // clean error path for "file too small" / "magic bytes missing"
  // that doesn't require the PDF.js worker to be configured.
  validatePDFBuffer(buffer);
  // Hash first: the bytes handed to PDF.js may be transferred.
  const contentHash = opts.contentHash ?? (await contentHashFromBuffer(buffer));
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
/**
 * 2026-11-16 — a MAPPED plan (≥1 calibration) must stay a single-page
 * plan: refuse a multi-page new version, which would orphan its
 * mapping. Runs inside the version-write transaction.
 */
async function assertVersionKeepsMapping(
  pdfFileId: string,
  parsed: ParsedPdf,
): Promise<void> {
  if (parsed.pageCount <= 1) return;
  const mapped = await db.calibrations
    .filter((c) => c.pdfFileId === pdfFileId)
    .count();
  if (mapped > 0) throw new MappedPlanMultiPageError(parsed.name, parsed.pageCount);
}

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

/**
 * Import `file` as a PDF of `buildingId` (new file or new latest
 * version). Throws on invalid / multi-page-over-mapped; callers wrap
 * errors for the UI.
 */
export async function importPdfFile(
  file: File,
  buildingId: string,
  opts: { contentHash?: string } = {},
): Promise<LoadPdfResult> {
  // Parse + fingerprint before opening a transaction. If this
  // throws (corrupt, oversized) the Dexie write never starts.
  const parsed = await parsePdfFile(file, opts);

  // Version-key lookup and writes in ONE rw transaction: same
  // (buildingId, name) → new version; new pair → new file row.
  // A failure rolls back the blob, file and version rows together.
  return db.transaction(
    "rw",
    [db.pdfFiles, db.pdfVersions, db.pdfBlobs, db.calibrations],
    async () => {
      const existing = await findPdfFileByName(buildingId, file.name);
      let pdfFile: PdfFileRecord;
      if (existing) {
        await assertVersionKeepsMapping(existing.id, parsed);
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
}

/** Append `file` as a new latest version of an existing PDF file row. */
export async function replacePdfFile(
  pdfFileId: string,
  file: File,
): Promise<LoadPdfResult> {
  if (!(await db.pdfFiles.get(pdfFileId))) {
    throw new Error(`PdfFileRecord not found: ${pdfFileId}`);
  }
  const parsed = await parsePdfFile(file);
  return db.transaction(
    "rw",
    [db.pdfVersions, db.pdfBlobs, db.pdfFiles, db.calibrations],
    async () => {
      if (!(await db.pdfFiles.get(pdfFileId))) {
        throw new Error(`PdfFileRecord not found: ${pdfFileId}`);
      }
      await assertVersionKeepsMapping(pdfFileId, parsed);
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
}
