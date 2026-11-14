// @ff/types — Wave 13 saved viewpoints (3D).
//
// Persisted rows live in the Dexie `viewerViewpoints` table (v10);
// the serialized camera + section-plane payload is stored as a
// JSON string in `blob`. Keeping the snapshot shape here (rather
// than in @ff/viewer-react) lets apps/settings, apps/models, and
// @ff/data all share one structural contract without any of them
// reaching into the viewer package for a type-only import.

/**
 * One section clipping plane in a saved viewpoint. Plain numbers only —
 * the viewer's THREE.Vector3 never crosses a serialization boundary.
 */
export interface ViewpointSectionPlane {
  point: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

/**
 * Wave 54 — the manual-visibility overlay captured with a viewpoint.
 * Serialized form of the ff-viewer-tools overlay store (Maps/Sets →
 * plain arrays so JSON round-trips). `hidden` entries are per model;
 * `isolate` is null when nothing was isolated at save time. Legacy
 * blobs (pre-wave-54) simply lack the field — decoders treat absence
 * as "no visibility state saved" and leave the live overlay untouched.
 */
export interface ViewpointVisibility {
  hidden: Array<{ modelId: string; ids: number[] }>;
  isolate: { visible: Array<{ modelId: string; ids: number[] }> } | null;
}

/**
 * Camera pose snapshot. Structurally identical to the viewer's
 * `ViewerPose` (`{ pos, target, fov, isOrtho }`) so a pose captured
 * from `IfcViewerHandle.getPose()` round-trips without mapping. Kept
 * as an independent interface so @ff/types stays a leaf package.
 */
export interface ViewerViewpointPose {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  isOrtho: boolean;
}

/**
 * The serialized content of `ViewerViewpointRecord.blob`
 * (`JSON.stringify` of this shape). Camera pose + the list of section
 * planes active at save time. The horizontal floor clip is
 * intentionally NOT included — it is level state, not view state.
 */
export interface ViewerViewpointSnapshot {
  pose: ViewerViewpointPose | null;
  sectionPlanes: ViewpointSectionPlane[];
  /** Wave 54 — manual hide/isolate overlay at save time (optional for
   * legacy-blob compatibility). */
  visibility?: ViewpointVisibility | null;
}

/**
 * Dexie v10 record for a saved 3D viewpoint. One row per saved view,
 * scoped to a project. `blob` is the JSON-encoded
 * `ViewerViewpointSnapshot` (Dexie stores the string verbatim).
 */
export interface ViewerViewpointRecord {
  /** Stable UUID. */
  id: string;
  /** FK → ProjectRecord.id. */
  projectId: string;
  /** User-facing label shown in the saved-views list. */
  name: string;
  /** Epoch ms; written on insert. */
  createdAt: number;
  /** JSON-encoded ViewerViewpointSnapshot. */
  blob: string;
}