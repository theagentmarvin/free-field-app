import { z } from 'zod';
import { BlobFields, SyncBaseSchema } from './syncBase';

/**
 * Phase 1c/1d synced collections other than buildings/folders
 * (docs/SPEC-PHASE-1.md §4). Field names mirror the Dexie row types in
 * `@ff/types` (project.ts, viewerViewpoints.ts); the Dexie `updatedAt`
 * (epoch ms) is replaced by the server-stamped `updatedAt` of the base.
 */

const id = z.string().min(1);

/** /projects/{pid}/ifcFiles/{id}  (IfcFileRecord) */
export const IfcFileSchema = z
  .object({
    id,
    buildingId: id,
    name: z.string().min(1),
    currentVersionId: z.string(), // '' until the first version lands
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);
export type IfcFile = z.infer<typeof IfcFileSchema>;

/**
 * /projects/{pid}/ifcVersions/{id}  (IfcVersionRecord + blob references)
 *
 * Append-only chain (uuid ids). Two blobs hang off a version:
 *  - the original `.ifc`   (`storagePath`, `sha256`, `sizeBytes`, `contentType`)
 *    OPTIONAL: nothing has to upload IFC; the mobile app never reads it.
 *  - the converted `.frag` (`fragStoragePath`, `fragSha256`, `fragSizeBytes`)
 *    which is what devices download. `null` until it is uploaded.
 * `contentHash`/`ifcFileSize`/`fragBlobKey` are the existing Dexie fields
 * (`contentHash` is the cheap SHA-256(first 64 KB + size), `sha256` is the
 * full-content hash used to verify downloads).
 */
export const IfcVersionSchema = z
  .object({
    id,
    ifcFileId: id,
    versionNumber: z.number().int().positive(),
    ifcFileSize: z.number().int().nonnegative(),
    contentHash: z.string(),
    fragBlobKey: z.string(),
    storeyCount: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    isLatest: z.boolean(),
    storagePath: BlobFields.storagePath.nullable(),
    sha256: BlobFields.sha256.nullable(),
    sizeBytes: BlobFields.sizeBytes.nullable(),
    contentType: BlobFields.contentType.nullable(),
    fragStoragePath: BlobFields.storagePath.nullable(),
    fragSha256: BlobFields.sha256.nullable(),
    fragSizeBytes: BlobFields.sizeBytes.nullable(),
  })
  .merge(SyncBaseSchema);
export type IfcVersion = z.infer<typeof IfcVersionSchema>;

/**
 * /projects/{pid}/storeys/{id}  (StoreyRecord)
 * NOTE: `containedElementIds` can be large for big storeys (Firestore docs
 * are capped at 1 MiB); see docs/integration/w70-sync-contracts.md.
 */
export const StoreySchema = z
  .object({
    id,
    buildingId: id,
    ifcVersionId: id,
    sourceIfcFileId: id,
    name: z.string().min(1),
    elevation: z.number(),
    expressId: z.number().int(),
    height: z.number().nullable(),
    containedElementIds: z.array(z.number().int()),
  })
  .merge(SyncBaseSchema);
export type Storey = z.infer<typeof StoreySchema>;

/** /projects/{pid}/extractedStoreys/{id}  (ExtractedStoreyRecord) */
export const ExtractedStoreySchema = z
  .object({
    id,
    buildingId: id,
    storeyId: id,
  })
  .merge(SyncBaseSchema);
export type ExtractedStorey = z.infer<typeof ExtractedStoreySchema>;

/** /projects/{pid}/pdfFiles/{id}  (PdfFileRecord) */
export const PdfFileSchema = z
  .object({
    id,
    buildingId: id,
    name: z.string().min(1),
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);
export type PdfFile = z.infer<typeof PdfFileSchema>;

/**
 * /projects/{pid}/pdfVersions/{id}  (PdfVersionRecord + blob references)
 * `size` (Dexie) and `sizeBytes` (blob contract) carry the same number.
 */
export const PdfVersionSchema = z
  .object({
    id,
    pdfFileId: id,
    versionNumber: z.number().int().positive(),
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    contentHash: z.string(),
    pageCount: z.number().int().positive(),
    width: z.number(),
    height: z.number(),
    storedAt: z.number().int(),
    blobKey: z.string(),
    isLatest: z.boolean(),
    ...BlobFields,
  })
  .merge(SyncBaseSchema);
export type PdfVersion = z.infer<typeof PdfVersionSchema>;

const PointPair = z.object({
  pdfX: z.number(),
  pdfY: z.number(),
  worldX: z.number(),
  worldZ: z.number(),
});

/**
 * /projects/{pid}/calibrations/{docId}  (CalibrationRecord)
 * Deterministic doc id (`calibrationDocId`): two devices calibrating the same
 * (pdfFileId, storeyName) pair converge on one doc. `id` equals the doc id.
 */
export const CalibrationSchema = z
  .object({
    id,
    projectId: id,
    pdfFileId: id,
    storeyName: z.string().min(1),
    pointPairs: z.tuple([PointPair, PointPair]),
    transformParams: z.object({
      scale: z.number(),
      rotation: z.number(),
      translateX: z.number(),
      translateZ: z.number(),
    }),
    confidence: z.number(),
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);
export type Calibration = z.infer<typeof CalibrationSchema>;

/**
 * /projects/{pid}/folderAssignments/{pdfFileId}  (PdfFolderAssignmentRecord)
 * Doc id == `pdfFileId` (one folder per PDF). The adapter uses `pdfFileId` as
 * the local row id for this table (the Dexie row already has `&pdfFileId`).
 * Moving a PDF = update `folderId`; unfiling = tombstone.
 */
export const FolderAssignmentSchema = z
  .object({
    id,
    pdfFileId: id,
    folderId: id,
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);
export type FolderAssignment = z.infer<typeof FolderAssignmentSchema>;

/**
 * /projects/{pid}/viewpoints/{id}  (ViewerViewpointRecord)
 * `blob` is the JSON-encoded ViewerViewpointSnapshot (rules cap it < 256 KB).
 */
export const ViewpointSchema = z
  .object({
    id,
    projectId: id,
    name: z.string().min(1),
    createdAt: z.number().int(),
    blob: z.string().max(256_000),
  })
  .merge(SyncBaseSchema);
export type Viewpoint = z.infer<typeof ViewpointSchema>;

/**
 * Deterministic calibration doc id. `storeyName` is user text and may contain
 * `/` (illegal in a doc id), so it is percent-encoded.
 */
export function calibrationDocId(pdfFileId: string, storeyName: string): string {
  return `${pdfFileId}__${encodeURIComponent(storeyName)}`;
}

/** Folder assignment doc id (one folder per PDF). */
export function folderAssignmentDocId(pdfFileId: string): string {
  return pdfFileId;
}
