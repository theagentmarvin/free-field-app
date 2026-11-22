// Dexie v9 records — task module (plan 2026-11-01 §2.4, task-39).
//
// The whole client-side data-plane borrowing for cloud-first: an
// offline write queue (`outbox`) and crash-recovery compose state
// (`drafts`). Reads are NOT mirrored — Firestore's own persistence
// cache (initFirestore) serves warm reads.

/** Outbox row states (plan §4). `killed` is the delete-sheet tombstone. */
export type OutboxState = "added" | "sending" | "sent" | "failed" | "killed";

/** Photo blob references carried with a queued action (keys into the
 *  blob store / in-memory map; resolved to TaskPhoto metadata on upload). */
export interface OutboxPhotoRef {
  blobKey: string;
  sha256: string; // 64-hex, computed client-side (WebCrypto)
  size: number;
  mime: string;
}

/**
 * Outbox row kinds. `task-action` is the original (tasks) kind and keeps its
 * untyped `payload` contract. The others are the generalized sync kinds of
 * docs/SPEC-PHASE-1.md §5 (1c/1d); their payloads are typed below, and
 * `SyncOutboxRecord` narrows a row by `kind`.
 */
export type OutboxKind =
  | "task-action"
  | "doc-upsert"
  | "doc-delete"
  | "blob-upload"
  | "blob-download";

export type SyncOutboxKind = Exclude<OutboxKind, "task-action">;

/** Synced collection names (mirrors `SyncedCollectionName` in @ff/firestore). */
export type SyncCollectionName =
  | "buildings"
  | "ifcFiles"
  | "ifcVersions"
  | "storeys"
  | "extractedStoreys"
  | "pdfFiles"
  | "pdfVersions"
  | "calibrations"
  | "folders"
  | "folderAssignments"
  | "viewpoints";

/** Storage blob families (`projects/{pid}/{ifc,frag,pdf}/{versionId}.{ext}`). */
export type SyncBlobKind = "ifc" | "frag" | "pdf";

/** Create/overwrite a synced doc from a local row. The writer stamps
 *  `updatedAt`/`updatedBy`/`schema`; `data` is the Dexie row's fields. */
export interface DocUpsertPayload {
  collection: SyncCollectionName;
  docId: string;
  data: Record<string, unknown>;
}

/** Tombstone a synced doc (`deletedAt = serverTimestamp()`); never a hard delete. */
export interface DocDeletePayload {
  collection: SyncCollectionName;
  docId: string;
}

/** Upload a local blob (key into fragBlobs/pdfBlobs) to Storage. Create-only:
 *  an already-existing object with the same sha256 counts as success. */
export interface BlobUploadPayload {
  kind: SyncBlobKind;
  versionId: string;
  /** Local blob store key (fragBlobs.key / pdfBlobs.key). */
  blobKey: string;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

/** Download a Storage blob into the local cache (resumable, verified). */
export interface BlobDownloadPayload {
  kind: SyncBlobKind;
  versionId: string;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  /** Where the bytes land locally (fragBlobs.key / pdfBlobs.key). */
  blobKey: string;
  /** Progress for UI + resume; written by the download manager. */
  bytesDownloaded?: number;
}

export type SyncOutboxPayloadByKind = {
  "doc-upsert": DocUpsertPayload;
  "doc-delete": DocDeletePayload;
  "blob-upload": BlobUploadPayload;
  "blob-download": BlobDownloadPayload;
};

/** An outbox row of a sync kind with its payload typed by `kind`. */
export type SyncOutboxRecord = {
  [K in SyncOutboxKind]: Omit<OutboxRecord, "kind" | "payload"> & {
    kind: K;
    payload: SyncOutboxPayloadByKind[K];
  };
}[SyncOutboxKind];

/**
 * A queued task action. The engine (ff-tasks) drives state:
 *   added → sending → sent | failed (attempts ≥ 3) | killed
 * `clientGuid` is the timeline-entry doc id — the idempotency key
 * that makes a retried transaction a no-op (rules enforce the
 * docId == clientGuid equality).
 */
export interface OutboxRecord {
  id: string; // uuid (row id)
  kind: OutboxKind; // "task-action" (tasks) + the Phase 1c/1d sync kinds
  state: OutboxState;
  projectId: string;
  payload: Record<string, unknown>; // TaskActionPayload (ff-tasks owns the shape)
  photoRefs: OutboxPhotoRef[];
  attempts: number;
  lastError?: string;
  clientGuid: string;
  resultTaskId?: string; // echoed after a successful commit
  createdAt: number;
  sentAt?: number;
}

/**
 * Half-composed task, auto-snapshotted (15 s cadence while dirty,
 * Day-3 UI) for crash recovery. `draft` is a TaskDraftFields JSON —
 * never sent to the cloud; only the completed action enters the outbox.
 */
export interface TaskDraftRecord {
  id: string; // taskId (client uuid, allocated at compose start)
  projectId: string;
  updatedAt: number;
  draft: Record<string, unknown>;
}

/**
 * w72 — plan pin anchor stored on a task (`location.pdf`).
 *
 * `pdfVersionId` (PdfVersionRecord.id) names the plan REVISION the pin was
 * placed on; without it a revised plan silently moves every pin onto the
 * new drawing. Optional so pre-w72 pins stay valid.
 */
export interface TaskPdfLocation {
  pdfFileId: string;
  /** 1-based page */
  page: number;
  /** normalized 0..1, origin top-left */
  uv: [number, number];
  /** Calibration used at pin time; `UNCALIBRATED_CALIB_ID` when none exists. */
  calibId: string;
  pdfVersionId?: string;
}

/**
 * Official `calibId` for a pin placed on a plan that has no calibration
 * (the offline/mobile client). `calibId` stays a required non-empty
 * string: the 2D position (uv) is still exact, and the sentinel makes the
 * calibration-drift rule fire once the plan is later calibrated
 * (`pin.calibId !== activeCalibration.id`), so 3D jumps warn instead of
 * silently re-projecting.
 */
export const UNCALIBRATED_CALIB_ID = "uncalibrated";
