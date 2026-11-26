// @ff/types: plan markups (vector drawings on a plan page).
//
// One Dexie row per markup, scoped to a plan VERSION page
// (pdfFileId + pdfVersionId + page). Geometry is stored in normalised page
// coordinates (u, v in 0..1, origin top-left of the page, v down), the same
// space as task plan pins, so a markup is correct at every zoom and tile level.
// Synced as `projects/{pid}/planMarkups/{id}` (docs/integration/plan-markups.md).

/** The drawing tools a markup can come from. */
export type PlanMarkupKind =
  | "pen"
  | "highlight"
  | "arrow"
  | "rect"
  | "ellipse"
  | "cloud"
  | "text";

export const PLAN_MARKUP_KINDS: readonly PlanMarkupKind[] = [
  "pen",
  "highlight",
  "arrow",
  "rect",
  "ellipse",
  "cloud",
  "text",
];

/** A normalised page point `[u, v]`. */
export type PlanMarkupPoint = [number, number];

/**
 * Decoded content of `PlanMarkupRecord.shape` (`JSON.stringify` of this).
 *  - pen / highlight: `pts` is the simplified polyline.
 *  - arrow: `pts` is `[tail, head]`.
 *  - rect / ellipse / cloud: `pts` is two opposite corners (the bounding box).
 *  - text: `pts` is `[anchor]` (top-left of the label), `text` the content and
 *    `size` the glyph height as a fraction of the page width.
 */
export interface PlanMarkupShape {
  pts: PlanMarkupPoint[];
  text?: string;
  size?: number;
}

/** Dexie v12 record. */
export interface PlanMarkupRecord {
  /** Stable UUID (also the Firestore doc id). */
  id: string;
  /** FK -> ProjectRecord.id. */
  projectId: string;
  pdfFileId: string;
  pdfVersionId: string;
  /** 1-based page number. */
  page: number;
  kind: PlanMarkupKind;
  /** `#rrggbb`. */
  color: string;
  /** Stroke width as a fraction of the page width (uv units). */
  strokeWidth: number;
  /** JSON-encoded `PlanMarkupShape`. */
  shape: string;
  /** `[minU, minV, maxU, maxV]` of the drawn shape (stroke excluded). */
  bbox: number[];
  /** Task created from this markup, when any. */
  taskId: string | null;
  /** uid of the author. */
  createdBy: string;
  /** Epoch ms. */
  createdAt: number;
  /** Server `updatedAt` (epoch ms) of the last synced doc. Absent = local-only. */
  remoteUpdatedAt?: number;
}
