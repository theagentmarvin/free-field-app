// packages/ff-data/src/index.ts
//
// Public barrel for @ff/data — the shared FreeField data core.
//
// This package owns the single app-wide Dexie database instance,
// its table accessors, calibration math, and (via the ./hooks
// subpath) the IFC/PDF pipeline React hooks. It is the honest
// package edge that replaced the old `@core/*` path-alias coupling
// (every module used to reach into apps/settings/src/core through
// aliases that only worked because the modules were co-mounted in
// the settings Vite server).
//
// Import styles (both supported):
//   - Barrel:   import { db, uuid } from "@ff/data";
//   - Subpath:  import { db } from "@ff/data/db/database";
//               import { computeSimilarityTransform } from "@ff/data/calibration/similarity";
//   - Hooks:    import { useIfcPipeline } from "@ff/data/hooks";
//
// The subpath form is what the mechanical migration used (pure
// `@core/db/X` -> `@ff/data/db/X` prefix swap); the barrel is the
// preferred surface for new code.
//
// This module is framework-agnostic (no React). React hooks live
// under ./hooks so the pure Dexie layer never drags the React tree
// into non-React consumers (tooling, node scripts, tests).

// ── Database instance + schema ───────────────────────────────────
export {
  db,
  ProjectDatabase,
  DATABASE_NAME,
  onDatabaseLifecycle,
  installDatabaseLifecycle,
  requestPersistentStorage,
  type DatabaseLifecycleEvent,
  type SyncStateRecord,
} from "./db/database";
export {
  StorageQuotaExceededError,
  isQuotaExceededError,
  toStorageError,
} from "./db/errors";

// ── Primitives ───────────────────────────────────────────────────
export { uuid } from "./db/uuid";
export { computeContentHash, computeFullContentHash } from "./db/files/hash";

// ── Table accessors ──────────────────────────────────────────────
export * from "./db/tables/projects";
export * from "./db/tables/buildings";
export * from "./db/tables/ifcFiles";
export * from "./db/tables/ifcVersions";
export * from "./db/tables/fragBlobs";
export * from "./db/tables/storeys";
export * from "./db/tables/extractedStoreys";
export * from "./db/tables/buildingLevelSelection";
export * from "./db/tables/calibrations";
export * from "./db/tables/filterPresets";
export * from "./db/tables/propertyCatalog";
export * from "./db/tables/pdfFiles";
export * from "./db/tables/pdfVersions";
export * from "./db/tables/pdfBlobs";
export * from "./db/tables/blobMiss";
export * from "./db/tables/pdfFolders";
export * from "./db/tables/pdfFolderAssignments";
export * from "./db/tables/viewerViewpoints";

// ── IFC import persistence (one-transaction write path) ─────────
export {
  appendIfcVersion,
  IfcFileNotFoundError,
  type AppendIfcVersionInput,
  type AppendIfcVersionResult,
} from "./db/appendIfcVersion";
export { disambiguateStoreyNames } from "./ifc/storeyNames";

// ── Phase 1 one-time local re-key (wave 65) ─────────────────────
export {
  rekeyLegacyProjectData,
  legacyRekeyMarkerKey,
  LEGACY_REKEY_MARKER_PREFIX,
  type LegacyRekeyOptions,
  type LegacyRekeyResult,
  type LegacyRekeyStatus,
  type LegacyRekeyTable,
  type RekeyMarkerStorage,
} from "./db/legacyProjectRekey";
export { LEGACY_DEFAULT_PROJECT_ID } from "@ff/types";

// ── Calibration math ─────────────────────────────────────────────
export * from "./calibration/similarity";
export * from "./pdfKind";
