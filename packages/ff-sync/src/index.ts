/**
 * @ff/sync — headless Phase 1c/1d sync engine. See
 * docs/integration/w71-sync-engine.md for the API the mobile app calls.
 * Firebase-backed ports live in `@ff/sync/firebase`.
 */

export { SyncEngine, createSyncEngine } from "./engine";
export type {
  SyncEngineDeps,
  StartOptions,
  PublishInfo,
  BuildingDownloadResult,
} from "./engine";
export { BlobIntegrityError, SyncFatalError, dexieBlobStore, defaultHasher } from "./blobs";
export { TABLES, TABLE_BY_COLLECTION, MAX_CONTAINED_IDS } from "./tables";
export type { TableConfig } from "./tables";
export { toDocData, fromDocData, applyChanges } from "./adapter";
export { registerBlobMissHandler } from "./register";
export type {
  RemoteDocs,
  RemoteChange,
  RemoteSubscription,
  BlobTransport,
  BlobReader,
  BlobSink,
  BlobHasher,
  StorageObjectInfo,
  SyncEvent,
  SyncListener,
  SyncClock,
} from "./types";
