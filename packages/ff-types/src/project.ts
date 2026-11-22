// src/core/types/project.ts
//
// All Dexie v1 record interfaces. See docs/SPEC-PHASE-1.md §4 for the
// authoritative schema and invariants.

/** A top-level project. Free Field lets users organize buildings under projects. */
export interface ProjectRecord {
  id: string;                       // uuid
  name: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

/**
 * A user-defined building container. NOT derived from `IfcBuilding` —
 * the user names the container (e.g. "Edificio Norte", "Torre A") and
 * each container has its own IFCs, storeys, and (future) PDFs.
 */
export interface BuildingRecord {
  id: string;
  projectId: string;                // FK
  name: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/**
 * A logical IFC file. `name` + `buildingId` is the version key:
 * re-uploading the same filename under the same building creates a new
 * `IfcVersionRecord` rather than a new file record.
 */
export interface IfcFileRecord {
  id: string;
  buildingId: string;               // FK
  name: string;                     // original filename — version key
  currentVersionId: string;         // FK → IfcVersionRecord (the latest)
  createdAt: number;
  updatedAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/** A concrete version of an IFC. v1, v2, ... */
export interface IfcVersionRecord {
  id: string;
  ifcFileId: string;                // FK
  versionNumber: number;            // 1, 2, 3...
  ifcFileSize: number;              // bytes of original .ifc
  contentHash: string;              // SHA-256(first 64KB + size)
  fragBlobKey: string;              // FK → fragBlobs.key
  storeyCount: number;
  createdAt: number;
  isLatest: boolean;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
  /** Phase 1d: blob references, set once the blob is in Storage (or by down-sync). */
  storagePath?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  contentType?: string | null;
  fragStoragePath?: string | null;
  fragSha256?: string | null;
  fragSizeBytes?: number | null;
}

/** A parsed storey from one IFC version. */
export interface StoreyRecord {
  id: string;
  buildingId: string;               // FK (denormalized for fast queries)
  ifcVersionId: string;             // FK
  sourceIfcFileId: string;          // FK (denormalized)
  name: string;                     // IfcBuildingStorey.Name
  elevation: number;                // Z
  expressId: number;                // IFC entity ID (the storey itself)
  height: number | null;
  /**
   * Express IDs of every IFC element contained in this storey, as
   * recorded in `IfcRelContainedInSpatialStructure`. Required for
   * the Models-tool Levels filter to isolate or hide a level —
   * without it, the filter would only toggle the (invisible)
   * storey entity itself. Empty array for storeys with no
   * containment entries (rare; some IFC files use IfcRelAggregates
   * instead — accepted limitation, see Task 22-amendment).
   */
  containedElementIds: number[];
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/** Marks a storey as "extracted" (visible in the user's mapped set) per building. */
export interface ExtractedStoreyRecord {
  id: string;
  buildingId: string;               // FK
  storeyId: string;                 // FK → StoreyRecord (unique per building)
  updatedAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/**
 * Binary storage for `.frag` payloads. Stored as a Blob so Dexie can keep
 * it in IndexedDB without materializing the whole thing in memory.
 */
export interface FragBlobRecord {
  key: string;                      // primary key, matches IfcVersionRecord.fragBlobKey
  blob: Blob;
}

// ────────────────────────────────────────────────────────────────────────
// PDF records (v3, Task 11)
//
// Mirror the IFC shape: a logical PdfFileRecord (one per (buildingId,
// name) pair) + an unbounded chain of PdfVersionRecord rows + raw bytes
// in pdfBlobs. See docs/TASK-11-PDF-CANVAS.md "Schema".
// ────────────────────────────────────────────────────────────────────────

/**
 * A logical PDF file. `name` + `buildingId` is the version key:
 * re-uploading the same filename under the same building creates a new
 * `PdfVersionRecord` rather than a new file record.
 */
export interface PdfFileRecord {
  id: string;                       // uuid
  buildingId: string;               // FK
  name: string;                     // original filename — version key
  createdAt: number;
  updatedAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/** A concrete version of a PDF. v1, v2, ... */
export interface PdfVersionRecord {
  id: string;                       // uuid
  pdfFileId: string;                // FK
  versionNumber: number;            // 1, 2, 3...
  name: string;                     // original filename
  size: number;                     // bytes
  contentHash: string;              // SHA-256(first 64KB + size)
  pageCount: number;                // 1 (single-page enforced at validation)
  width: number;                    // PDF page width in points
  height: number;                   // PDF page height in points
  storedAt: number;                 // Date.now()
  blobKey: string;                  // FK → pdfBlobs.key
  isLatest: boolean;                // exactly one true per pdfFileId
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
  /** Phase 1d: blob references, set once the blob is in Storage (or by down-sync). */
  storagePath?: string;
  sha256?: string;
  sizeBytes?: number;
  contentType?: string;
}

/**
 * Binary storage for raw PDF bytes. Stored as a Blob so Dexie can keep
 * it in IndexedDB without materializing the whole thing in memory.
 */
export interface PdfBlobRecord {
  key: string;                      // primary key, matches PdfVersionRecord.blobKey
  bytes: Blob;                      // raw PDF file
}

// ────────────────────────────────────────────────────────────────────────
// Calibration records (v4, Task 12a Part 2)
//
// Stores a 2-point similarity transform (translation + rotation +
// uniform scale) that maps a single-page PDF to a single storey of
// the 3D world. One CalibrationRecord per (pdfFileId, storeyName)
// pair. See docs/TASK-12a-CALIBRATION-WIZARD.md "Data layer" for
// the schema rationale.
// ────────────────────────────────────────────────────────────────────────

/**
 * One of the two point pairs that anchors the similarity transform.
 * Stored in the PDF's native page-coord space (pdfX, pdfY) and the
 * 3D world's floor-plan space (worldX, worldZ). Note: we use Z
 * (not Y) for the second world axis because the calibration is a
 * plan-view mapping — the 3D "vertical" axis is up (Y), and the
 * floor plan lives in the X-Z plane.
 */
export interface CalibrationPointPair {
  pdfX: number;
  pdfY: number;
  worldX: number;
  worldZ: number;
}

/**
 * The four DOF of the 2D similarity transform: translation (tx, tz),
 * rotation (radians), and uniform scale (world-units per PDF-point).
 *
 * Forward map (PDF → world):
 *   worldX = scale * (cos(r) * pdfX - sin(r) * pdfY) + translateX
 *   worldZ = scale * (sin(r) * pdfX + cos(r) * pdfY) + translateZ
 *
 * For 2-point calibration, the four DOF are uniquely determined.
 * The math lives in `src/core/calibration/similarity.ts`.
 */
export interface CalibrationTransformParams {
  scale: number;
  rotation: number;
  translateX: number;
  translateZ: number;
}

// ────────────────────────────────────────────────────────────────────────
// PDF folder records (v8, Task 20F — Folder grouping for PDFs)
//
// Folders let the user group PDFs across buildings within a project
// by category ("Architecture", "Finishes", "Furniture"). Folders
// are project-scoped (so a single "Architecture" folder can hold
// architectural PDFs from every building in the project) and
// nestable (a folder can have a parentId). One PdfFolderRecord per
// (projectId, parentId, name) tuple at each depth.
//
// See docs/task-20f-pdf-folders.md §"Schema" for the rationale.
// ────────────────────────────────────────────────────────────────────────

/**
 * A user-defined folder for grouping PDFs. `parentId === null`
 * means the folder is at the project root. Nested folders are
 * arbitrary-depth; the UI's <FolderTree> flattens them for
 * rendering but the data is just a flat list of rows.
 *
 * Folders are independent of buildings — a single folder can hold
 * PDFs from multiple buildings in the same project.
 *
 * Renames propagate through the join table (which holds
 * `folderId`, not `folderName`), so renaming a folder does NOT
 * touch any PdfFileRecord or PdfFolderAssignmentRecord row.
 */
export interface PdfFolderRecord {
  id: string;                       // uuid
  projectId: string;                // FK
  parentId: string | null;          // FK → PdfFolderRecord.id (null = root)
  name: string;                     // user-renameable
  /** Free-form CSS color for the chip. See `ff-folder-chip--{color}`. */
  color: string;
  createdAt: number;
  updatedAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/**
 * The join row that places a PDF into a folder. The `pdfFileId`
 * field is declared with `&` in the schema, so there is at most
 * one assignment per PDF (one-folder-per-PDF semantics). If the
 * user moves a PDF to a different folder, the assignment is
 * replaced (delete + insert), not duplicated.
 *
 * Cascade policy:
 *   - deletePdfFile(id) → all PdfFolderAssignment rows for that pdfFileId
 *   - deletePdfFolder(id) → all PdfFolderAssignment rows pointing at it
 *     (PDFs become "Unfiled")
 */
export interface PdfFolderAssignmentRecord {
  id: string;                       // uuid
  pdfFileId: string;                // FK (unique)
  folderId: string;                 // FK → PdfFolderRecord.id
  createdAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}

/**
 * A persisted calibration. Exactly one row per
 * (pdfFileId, storeyName) — the [pdfFileId+storeyName] compound
 * index in the Dexie v4 schema enforces that. The same PDF can
 * have multiple calibrations (one per storey).
 *
 * `confidence` is always 1.0 for the 2-point case (the transform is
 * exact for the two pairs). The field exists so a future 3+ point
 * fit can write a residual-derived score without a schema change.
 */
export interface CalibrationRecord {
  id: string;
  projectId: string;
  pdfFileId: string;
  storeyName: string;
  pointPairs: [CalibrationPointPair, CalibrationPointPair];
  transformParams: CalibrationTransformParams;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  /** Phase 1c: server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}
