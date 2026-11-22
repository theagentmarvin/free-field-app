// @ff/types — shared type definitions for FreeField apps.
//
// Cross-package type surface used by both @free-field/settings (Dexie
// schema, persistence layer) and @free-field/models (filter authoring
// UI). Domain types like FilterRule / FilterPreset currently live in
// apps/models/src/modelsToolStore.ts because that file is the
// canonical Zustand store for the in-memory filter tree. They are
// duplicated here only as type imports (not re-exports) so future
// extraction is straightforward.

/**
 * Boolean combinator joining sibling rules or sibling groups. "AND"
 * is the safe default; "OR" requires an explicit affordance (the
 * "+ OR group" button in CustomFilterBuilder) because naive OR
 * composition over a single property creates the
 * `FireRating=60 AND FireRating=90 → zero matches` trap that
 * search sets explicitly avoid.
 */
export type Combinator = "AND" | "OR";

/**
 * One named group of filter rules, joined by `combinator`. A
 * `FilterPreset` (see modelsToolStore.ts) contains one or more of
 * these, joined by the preset-level `combinator`.
 *
 * The `id` is a stable UUID — it's used as the React `key` and as
 * the deduplication key when a preset is persisted to Dexie. It
 * does NOT change when the group is renamed or its combinator is
 * flipped.
 */
export interface ConditionGroup {
  id: string;
  combinator: Combinator;
  rules: FilterRuleLike[];
}

/**
 * Subset of FilterRule (defined in apps/models/src/modelsToolStore.ts)
 * that's safe to serialize and round-trip through Dexie. Kept as a
 * structural type here to avoid an import cycle; the runtime store
 * narrows on assignment.
 *
 * We intentionally mirror the FilterRule shape verbatim: property,
 * operator, value, id. The serialization is plain JSON — Dexie's
 * structured-clone path treats the `id` and `value` strings as
 * primitives and `operator` as a string enum, so no marshaling is
 * needed.
 */
export interface FilterRuleLike {
  id: string;
  property: string;
  /** String-encoded enum; the evaluation engine parses at compare-time. */
  operator: string;
  value: string;
}

/**
 * Dexie v6 record for a saved filter preset. One row per
 * (buildingId, preset). The compound index
 * `[buildingId+updatedAt]` powers the live-query "most recently
 * saved presets per building" use case in
 * apps/models/src/hooks/useFilterPresetsForBuilding.ts.
 *
 * `groups` is serialized as a plain JSON array (Dexie stores it
 * verbatim under structured clone); the `combinator` field is the
 * preset-level joining operator across groups.
 */
export interface FilterPresetRecord {
  /** Stable UUID — the leaf's `id` in modelsToolStore.customTree. */
  id: string;
  /** FK → BuildingRecord.id (apps/settings Dexie v1). */
  buildingId: string;
  /** Display name shown in the Custom section. */
  name: string;
  /** How the groups within this preset join. */
  combinator: Combinator;
  /** The actual rule payload — one or more groups of rules. */
  groups: ConditionGroup[];
  /** Epoch ms; written on insert. */
  createdAt: number;
  /** Epoch ms; re-stamped on every upsert. */
  updatedAt: number;
}

// ── Dexie schema records (relocated from apps/settings/src/core/types,
//    2026-07-12 @ff/data extraction Phase 2). These are the persisted
//    row shapes for the FreeField IndexedDB. Kept as re-exports so the
//    package has a single public surface (@ff/types) and callers never
//    import deep paths.
export type {
  ProjectRecord,
  BuildingRecord,
  IfcFileRecord,
  IfcVersionRecord,
  FragBlobRecord,
  StoreyRecord,
  ExtractedStoreyRecord,
  CalibrationRecord,
  CalibrationPointPair,
  CalibrationTransformParams,
  PdfFileRecord,
  PdfVersionRecord,
  PdfBlobRecord,
  PdfFolderRecord,
  PdfFolderAssignmentRecord,
} from "./project";
export type { PropertyCatalogEntry } from "./propertyCatalog";
export type {
  OutboxRecord,
  OutboxState,
  OutboxPhotoRef,
  TaskDraftRecord,
  OutboxKind,
  SyncOutboxKind,
  SyncCollectionName,
  SyncBlobKind,
  DocUpsertPayload,
  DocDeletePayload,
  BlobUploadPayload,
  BlobDownloadPayload,
  SyncOutboxPayloadByKind,
  SyncOutboxRecord,
  TaskPdfLocation,
} from "./tasks";
export { UNCALIBRATED_CALIB_ID } from "./tasks";
export * from "./levelSelection";
export type {
  ViewpointSectionPlane,
  ViewpointVisibility,
  ViewerViewpointPose,
  ViewerViewpointSnapshot,
  ViewerViewpointRecord,
} from "./viewerViewpoints";
export { LEGACY_DEFAULT_PROJECT_ID } from "./projectIds";
