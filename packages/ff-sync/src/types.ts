/**
 * Ports of the sync engine. Everything that touches the outside world is an
 * interface here, so the core runs in the browser (web app), in a native
 * shell (mobile app) and in node (tests) with fakes.
 */

import type { SyncBlobKind, SyncCollectionName } from "@ff/types";

export type { SyncBlobKind, SyncCollectionName };

// ── Firestore port ──────────────────────────────────────────────────

/** One remote doc delivered by a listener (base keys already stripped). */
export interface RemoteChange {
  id: string;
  /** Server `updatedAt`, epoch ms. */
  updatedAtMs: number;
  /** Tombstone (`deletedAt != null`). */
  deleted: boolean;
  /** The doc's schema fields (no updatedAt / updatedBy / deletedAt / schema). */
  data: Record<string, unknown>;
}

export interface RemoteSubscription {
  onChanges(changes: RemoteChange[]): void;
  onError(err: unknown): void;
}

/**
 * Firestore, as the engine needs it. Implemented over the Firebase JS SDK in
 * `@ff/sync/firebase` (`createFirestoreRemote`); implement it natively (or
 * with a fake) elsewhere. All docs live at `projects/{pid}/<collection>/{id}`.
 */
export interface RemoteDocs {
  /**
   * Listen to docs with `updatedAt > afterMs` (all docs when null). Must
   * deliver server-confirmed docs only (not latency-compensated local
   * writes). Returns the unsubscribe function.
   */
  subscribe(
    projectId: string,
    collection: SyncCollectionName,
    afterMs: number | null,
    handlers: RemoteSubscription,
  ): () => void;
  /** Server read of one doc (`null` when it does not exist). */
  get(
    projectId: string,
    collection: SyncCollectionName,
    id: string,
  ): Promise<{ deleted: boolean; data: Record<string, unknown> } | null>;
  /** Server read of every doc whose `field == value` (version numbering). */
  listWhere(
    projectId: string,
    collection: SyncCollectionName,
    field: string,
    value: string,
  ): Promise<Array<Record<string, unknown>>>;
  /** Create or overwrite a doc; the implementation stamps updatedAt (server time), updatedBy, schema 1, deletedAt null. */
  upsert(
    projectId: string,
    collection: SyncCollectionName,
    id: string,
    data: Record<string, unknown>,
    uid: string,
  ): Promise<void>;
  /** Tombstone a doc (deletedAt = server time). No-op when missing or already deleted. */
  tombstone(
    projectId: string,
    collection: SyncCollectionName,
    id: string,
    uid: string,
  ): Promise<void>;
}

// ── Storage / blob ports ────────────────────────────────────────────

export interface StorageObjectInfo {
  sizeBytes: number;
  /** `sha256` custom metadata the uploader recorded, when present. */
  sha256?: string;
}

/** Cloud Storage, as the engine needs it (`createStorageTransport` in `@ff/sync/firebase`). */
export interface BlobTransport {
  /** `null` when the object does not exist. */
  head(path: string): Promise<StorageObjectInfo | null>;
  /** Create-only upload; objects are immutable. */
  upload(
    path: string,
    blob: Blob,
    opts: { contentType: string; sha256: string; onProgress?: (bytes: number, total: number) => void },
  ): Promise<void>;
  /** Download the whole object. */
  download(
    path: string,
    opts?: { onProgress?: (bytes: number, total: number) => void; signal?: AbortSignal },
  ): Promise<Blob>;
  /**
   * OPTIONAL streaming port (w72). A URL the client can fetch directly
   * (e.g. a Storage download URL) so a native client can stream a large
   * file to disk instead of holding it in a `Blob`. Used only together
   * with `BlobSink.putFromUrl`; when either is absent the engine falls
   * back to `download` + `BlobSink.put`.
   */
  getDownloadUrl?(path: string): Promise<string>;
}

/** Where local blobs are read from for upload (web: Dexie fragBlobs/pdfBlobs). */
export interface BlobReader {
  get(kind: SyncBlobKind, key: string): Promise<Blob | null>;
}

/**
 * Where downloaded blobs are written (web: Dexie fragBlobs/pdfBlobs; mobile:
 * the app filesystem). `put` receives bytes that already passed the sha256 /
 * size check.
 */
export interface BlobSink {
  has(kind: SyncBlobKind, key: string): Promise<boolean>;
  put(kind: SyncBlobKind, key: string, blob: Blob): Promise<void>;
  /**
   * OPTIONAL path-based / streaming write (w72). The sink fetches `url`
   * itself (native: straight to a temp file), VERIFIES the bytes against
   * `expected` (sha256 hex, and size when known) and only then commits
   * them under `key`. On mismatch it must discard the temp file and
   * throw `BlobIntegrityError` (exported from `@ff/sync`). The engine
   * does no hashing on this path.
   */
  putFromUrl?(
    kind: SyncBlobKind,
    key: string,
    url: string,
    expected: { sha256: string; sizeBytes?: number },
    opts?: { onProgress?: (bytes: number, total: number) => void; signal?: AbortSignal },
  ): Promise<void>;
}

/** Full-content SHA-256 (lowercase hex) of a Blob. Default uses WebCrypto. */
export type BlobHasher = (blob: Blob) => Promise<string>;

// ── Events ──────────────────────────────────────────────────────────

export type SyncEvent =
  | { type: "started"; projectId: string; canWrite: boolean }
  | { type: "stopped"; projectId: string }
  | { type: "down-applied"; collection: SyncCollectionName; upserted: number; deleted: number; skippedPending: number; skippedInvalid: number; conflicts: number }
  | { type: "down-error"; collection: SyncCollectionName; error: string }
  | { type: "outbox"; pending: number; failed: number }
  | { type: "publish-available"; projectId: string; buildings: number; rows: number }
  | { type: "blob-progress"; kind: SyncBlobKind; versionId: string; direction: "up" | "down"; bytes: number; total: number }
  | { type: "blob-done"; kind: SyncBlobKind; versionId: string; direction: "up" | "down" }
  | { type: "blob-error"; kind: SyncBlobKind; versionId: string; direction: "up" | "down"; error: string };

export type SyncListener = (event: SyncEvent) => void;

export interface SyncClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}
