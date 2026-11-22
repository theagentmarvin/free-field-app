/**
 * BCF export — contract between the pure writer (`bcf/*.ts`, this package)
 * and the integration layer (`@ff/tasks-react` TasksApp + the settings host).
 * Spec: docs/specs/tasks-bcf-export.md
 *
 * The writer is headless: no React, viewer, Firestore or DOM-canvas imports.
 * Everything it needs is injected through these types.
 */

export type BcfVersion = "2.1" | "3.0";

export type Vec3 = readonly [number, number, number];

/** A binary payload (snapshot / photo) already fetched by the caller. */
export interface BcfBinary {
  bytes: Uint8Array;
  /** "image/jpeg" | "image/png" | other image mime. */
  mime: string;
  /** Pixel size when known (used for the 3.0 AspectRatio). */
  width?: number;
  height?: number;
}

/** 3D camera as FreeField stores it (three.js world space, Y-up, metres). */
export interface BcfCameraPose {
  pos: Vec3;
  target: Vec3;
  /** Vertical field of view in degrees. */
  fov: number;
  isOrtho: boolean;
}

/** One IFC element linked to the task, already resolved by the host. */
export interface BcfComponent {
  /** 22-character IFC GlobalId. */
  ifcGuid: string;
  /** e.g. the source IFC file name. */
  originatingSystem?: string;
  /** e.g. `${modelId}:${expressId}`. */
  authoringToolId?: string;
}

/** Normalised task fields the writer maps (integration builds this from Task/TaskView). */
export interface BcfTaskSource {
  id: string;
  num: number;
  title: string;
  description: string;
  /** FreeField task type, e.g. "task". */
  type: string;
  /** FreeField numeric status (10, 20, 30, 40, 60, 65, 80). */
  status: number;
  /** "low" | "normal" | "high" | "critical" | null. */
  priority?: string | null;
  checklist?: readonly { text: string; done: boolean }[];
  createdAt: number;
  createdByUid: string;
  createdBy: string;
  updatedAt: number;
  /** Display name (FreeField stores no uid for the last editor). */
  updatedBy: string;
  assigneeUid: string | null;
  assigneeName: string | null;
  /** Epoch ms, or null. */
  deadline: number | null;
  buildingName?: string | null;
  storeyName?: string | null;
  /** Free-text location note. */
  locationText?: string | null;
  /** Human-readable 2D pin note built by the integration, e.g. "Sheet A101 · page 1 · at 42 %, 61 %". */
  sheetPinNote?: string | null;
  /** Attached sheets (names) for the description block. */
  sheetRefs?: readonly { name: string; page?: number; versionNumber?: number }[];
  /** 3D camera, or null for 2D-only / no location. */
  cameraPose?: BcfCameraPose | null;
}

/** Timeline entry (comments + activity). */
export interface BcfEntrySource {
  id: string;
  /** "create" | "comment" | "assign" | "complete" | "reject" | "approve" | "followup" | "discontinue" | "edit". */
  action: string;
  text: string;
  by: string;
  byUid: string;
  at: number;
  statusFrom: number | null;
  statusTo: number | null;
}

export interface BcfPhoto {
  binary: BcfBinary;
  caption?: string | null;
  /** Entry id when the photo came with a timeline entry. */
  entryId?: string | null;
}

/** Everything needed to write one topic. */
export interface BcfTaskBundle {
  task: BcfTaskSource;
  entries: readonly BcfEntrySource[];
  snapshot?: BcfBinary | null;
  photos?: readonly BcfPhoto[];
  /** Resolved linked elements (empty / undefined = none known). */
  components?: readonly BcfComponent[];
  /** Linked elements whose GUID could not be resolved (for warnings). */
  unresolvedComponents?: number;
}

export interface BcfUserDirectory {
  /**
   * Author string for a uid: email if known, else display name, else the uid.
   * `fallbackName` is the display name stored on the record.
   */
  author(uid: string | null | undefined, fallbackName?: string | null): string | null;
  /** Same, for records that only store a display name (e.g. `updatedBy`). */
  authorByName?(name: string | null | undefined): string | null;
}

export interface BcfExportOptions {
  version: BcfVersion;
  project: { id: string; name?: string | null };
  users: BcfUserDirectory;
  /**
   * Base model shift: FreeField world = (ifcX, ifcZ, -ifcY) + shift.
   * null = unknown, so no camera is written (the snapshot is still written).
   * Per building when tasks span several buildings: keyed by task id.
   */
  baseShift: Vec3 | null | ((taskId: string) => Vec3 | null);
  /** Optional deep link to the task in FreeField. */
  taskUrl?: (taskId: string) => string | null;
  /**
   * Converts a JPEG snapshot to PNG for 2.1 (browser: canvas). When absent,
   * a JPEG snapshot is written as `snapshot.jpg` in 2.1 too (with a warning).
   */
  convertToPng?: (b: BcfBinary) => Promise<BcfBinary>;
  /** Clock for deterministic tests. */
  now?: () => number;
  onProgress?: (done: number, total: number) => void;
}

export interface BcfWarning {
  taskId: string;
  taskNum: number;
  kind: "no-3d-view" | "unresolved-elements" | "snapshot-not-png" | "snapshot-downscaled" | "photo-skipped" | "ortho-scale-estimated";
  message: string;
}

export interface BcfExportResult {
  blob: Blob;
  /** Without directory, e.g. "freefield-tower-a-2026-11-22-bcf21.bcf". */
  filename: string;
  topicCount: number;
  warnings: BcfWarning[];
}

/** Writer entry points implemented in `bcf/index.ts`. */
export type BuildBcfFiles = (
  bundles: readonly BcfTaskBundle[],
  options: BcfExportOptions,
) => Promise<{ files: Map<string, string | Uint8Array>; warnings: BcfWarning[] }>;

export type ExportBcf = (
  bundles: readonly BcfTaskBundle[],
  options: BcfExportOptions,
) => Promise<BcfExportResult>;
