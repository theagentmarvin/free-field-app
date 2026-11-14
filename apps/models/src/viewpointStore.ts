// apps/models/src/viewpointStore.ts
//
// Wave 13 — pure save/restore logic for 3D saved viewpoints.
//
// No React, no Dexie imports: the viewer-surface reads/writes go
// through `IfcViewerHandle` here, and the Dexie row IO lives in
// @ff/data (`createViewerViewpoint` / `listViewerViewpoints` /
// `deleteViewerViewpoint`). The toolbar composes the two: capture →
// encode → `createViewerViewpoint`, `listViewerViewpoints` → decode →
// restore. Keeping the encode/decode + restore glue pure means the
// serialization round-trip and the restore ordering are unit-testable
// with a stubbed handle.

import type {
  IfcViewerHandle,
  ViewerPose,
} from "@ff/viewer-react";
import type {
  ViewerViewpointPose,
  ViewerViewpointSnapshot,
  ViewpointVisibility,
} from "@ff/types";

/**
 * The overlay slice capture reads — structurally identical to the
 * ff-viewer-tools `ManualVisibilityOverlay` so callers pass the store
 * state directly. Kept structural here so this module stays pure
 * (no store import).
 */
export interface VisibilityOverlayLike {
  hidden: ReadonlyMap<string, ReadonlySet<number>>;
  isolate: { visible: ReadonlyMap<string, ReadonlySet<number>> } | null;
}

/** Serialize the live overlay (Maps/Sets) into the JSON-safe shape. */
export function serializeVisibility(
  overlay: VisibilityOverlayLike | null | undefined,
): ViewpointVisibility | null {
  if (!overlay) return null;
  const hidden: Array<{ modelId: string; ids: number[] }> = [];
  for (const [modelId, ids] of overlay.hidden) {
    if (ids.size > 0) hidden.push({ modelId, ids: Array.from(ids) });
  }
  const isolate = overlay.isolate
    ? {
        visible: Array.from(overlay.isolate.visible, ([modelId, ids]) => ({
          modelId,
          ids: Array.from(ids),
        })),
      }
    : null;
  if (hidden.length === 0 && isolate === null) return null;
  return { hidden, isolate };
}

/** Parse a serialized visibility payload; null when absent/malformed. */
export function parseVisibility(
  raw: unknown,
): ViewpointVisibility | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<ViewpointVisibility>;
  if (!Array.isArray(obj.hidden)) return null;
  const hidden = obj.hidden.filter(
    (e): e is { modelId: string; ids: number[] } =>
      !!e && typeof e.modelId === "string" && Array.isArray(e.ids),
  );
  const isolate =
    obj.isolate && Array.isArray(obj.isolate.visible)
      ? {
          visible: obj.isolate.visible.filter(
            (e): e is { modelId: string; ids: number[] } =>
              !!e && typeof e.modelId === "string" && Array.isArray(e.ids),
          ),
        }
      : null;
  if (hidden.length === 0 && isolate === null) return null;
  return { hidden, isolate };
}

/**
 * Deserialize a saved visibility payload back into the store's
 * Map/Set shape (the exact argument `replaceOverlay` accepts).
 */
export function deserializeVisibility(v: ViewpointVisibility): {
  hidden: Map<string, Set<number>>;
  isolate: { visible: Map<string, Set<number>> } | null;
} {
  const hidden = new Map<string, Set<number>>(
    v.hidden.map((e) => [e.modelId, new Set(e.ids)]),
  );
  const isolate = v.isolate
    ? {
        visible: new Map<string, Set<number>>(
          v.isolate.visible.map((e) => [e.modelId, new Set(e.ids)]),
        ),
      }
    : null;
  return { hidden, isolate };
}

/** Max saved views per project (documented in the Wave-13 spec). */
export const MAX_VIEWPOINTS_PER_PROJECT = 12;

/**
 * Unit view direction of the camera (target − eye, normalized). Used
 * as the default normal for an "Add cut" section plane — "cut in the
 * current view direction". Falls back to (0, 0, −1) when the pose is
 * missing or degenerate (eye == target).
 */
export function cameraDirectionFromPose(
  pose: ViewerPose | null,
): { x: number; y: number; z: number } {
  if (!pose) return { x: 0, y: 0, z: -1 };
  const dx = pose.target[0] - pose.pos[0];
  const dy = pose.target[1] - pose.pos[1];
  const dz = pose.target[2] - pose.pos[2];
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: -1 };
  return { x: dx / len, y: dy / len, z: dz / len };
}

/**
 * Read a serializable snapshot out of the live handle: the camera
 * pose (via `getPose`) plus the active section planes (via
 * `getSectionPlanes`, in insertion order). The horizontal floor clip
 * is intentionally NOT captured — it is level state, not view state.
 *
 * Wave 54: an optional manual-visibility overlay (the ff-viewer-tools
 * store state) is serialized alongside, so a saved view restores what
 * was hidden/isolated. Absent/null overlay → `visibility: null`.
 */
export function captureViewpointSnapshot(
  h: IfcViewerHandle,
  overlay?: VisibilityOverlayLike | null,
): ViewerViewpointSnapshot {
  const pose = h.getPose();
  const poseLike: ViewerViewpointPose | null = pose
    ? {
        pos: pose.pos,
        target: pose.target,
        fov: pose.fov,
        isOrtho: pose.isOrtho,
      }
    : null;
  const sectionPlanes = h.getSectionPlanes().map((p) => ({
    point: { x: p.point.x, y: p.point.y, z: p.point.z },
    normal: { x: p.normal.x, y: p.normal.y, z: p.normal.z },
  }));
  return { pose: poseLike, sectionPlanes, visibility: serializeVisibility(overlay) };
}

/**
 * Apply a serialized snapshot to the live viewer: restore the camera
 * pose first, then clear existing section planes and re-add each saved
 * plane (point + normal) in order. `setViewPose` is a no-op when the
 * world is unmounted, and `addSectionPlane` is a no-op at the cap — but
 * saved snapshots never exceed `MAX_SECTION_PLANES`, so the cap guard
 * is defensive only.
 *
 * Wave 54: when the snapshot carries a visibility field AND the
 * caller supplies `applyVisibility`, it is invoked AFTER the geometry
 * restore (the store change re-triggers the filter effect, which
 * re-applies the merged visibility).
 *
 * Wave 63: `visibility: null` is a view saved with NOTHING hidden — it
 * is applied as `null` so the caller un-hides everything. Only legacy
 * blobs (saved before wave 54, `visibility` absent / undefined) leave
 * the live overlay untouched.
 */
export function restoreViewpoint(
  h: IfcViewerHandle,
  snap: ViewerViewpointSnapshot,
  applyVisibility?: (v: ViewpointVisibility | null) => void,
): void {
  if (snap.pose) {
    h.setViewPose({
      pos: snap.pose.pos,
      target: snap.pose.target,
      fov: snap.pose.fov,
      isOrtho: snap.pose.isOrtho,
    });
  }
  h.clearSectionPlanes();
  for (const plane of snap.sectionPlanes) {
    h.addSectionPlane(
      { x: plane.point.x, y: plane.point.y, z: plane.point.z },
      { x: plane.normal.x, y: plane.normal.y, z: plane.normal.z },
    );
  }
  if (applyVisibility && snap.visibility !== undefined) {
    applyVisibility(snap.visibility);
  }
}

/** Serialize a snapshot to the `blob` string stored in Dexie. */
export function encodeViewpointBlob(snap: ViewerViewpointSnapshot): string {
  return JSON.stringify(snap);
}

/**
 * Parse a `blob` back into a snapshot. Returns `null` for a malformed
 * or legacy blob (callers treat `null` as "unrestorable" and skip it).
 *
 * Wave 63: a blob WITHOUT a `visibility` key (saved before wave 54)
 * decodes with `visibility` absent, so restore leaves the overlay
 * alone; a blob with `visibility: null` (a "clean" view) keeps the
 * null so restore clears the overlay.
 */
export function decodeViewpointBlob(
  blob: string,
): ViewerViewpointSnapshot | null {
  try {
    const parsed = JSON.parse(blob) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Partial<ViewerViewpointSnapshot>;
    if (!Array.isArray(obj.sectionPlanes)) return null;
    const out: ViewerViewpointSnapshot = {
      pose: obj.pose ?? null,
      sectionPlanes: obj.sectionPlanes,
    };
    if ("visibility" in obj) out.visibility = parseVisibility(obj.visibility);
    return out;
  } catch {
    return null;
  }
}