// apps/models/src/contextToolbarState.ts
//
// Wave 47 — pure state/helpers for the right-click selection context
// toolbar. ZERO React, ZERO engine access: this module holds only
// types, constants, and pure functions that turn a selection snapshot
// + the per-model local-ID universe into a list of `setElementVisibility`
// operations. The <SelectionContextToolbar> component orchestrates the
// async parts (getAllModelExpressIds, category resolution fallback) and
// calls these helpers, keeping every arrow unit-testable without a
// viewer mount — the same seam pattern as `toolbarState.ts` (Wave 13).
//
// Engine access is strictly through the `IfcViewerHandle`: this module
// never imports `three` or `@thatopen/*`, and never constructs geometry.
// The `InvertedIndex` type is a type-only import from @ff/viewer-react.

import type { InvertedIndex } from "@ff/viewer-react";

/** One visibility mutation to apply to the viewer. */
export interface VisibilityOp {
  modelId: string;
  ids: ReadonlySet<number>;
  visible: boolean;
}

/** Snapshot shape returned by `IfcViewerHandle.getSelection()`. */
export type SelectionMap = ReadonlyMap<string, ReadonlySet<number>>;

/** All local IDs per loaded model (geometry-bearing identifiers). */
export type AllIdsMap = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * Estimated toolbar footprint for cursor clamping (CSS px).
 * Wave 49: width bumped 236 → 280 — the row gained the "Remove section
 * planes" button (40px) so clamping must account for the wider pill,
 * otherwise right-edge right-clicks let the toolbar overflow the viewport.
 * Wave 51: width 280 → 250 — the standalone 40px "Remove section planes"
 * button is gone (the remove action moved INTO the section split
 * button's dropdown) and the section button became a split group
 * (40px primary + 18px caret), so the row actually got NARROWER:
 * 58 (element) + 58 (category) + 40 (show all) + 58 (section) = 214,
 * + 3×8 gaps + 8 padding = 246 → 250 leaves a small margin.
 */
export const TOOLBAR_SIZE = { width: 250, height: 48 };

/**
 * Wave 54 — mobile long-press: hold duration (ms) that opens the
 * context toolbar on touch devices (the desktop `contextmenu` event
 * never fires on iOS Safari canvases).
 */
export const LONG_PRESS_MS = 500;

/**
 * Wave 54 — movement beyond this radius (CSS px) cancels a pending
 * long-press: the gesture is an orbit/pan, not a menu request.
 */
export const LONG_PRESS_MOVE_PX = 10;

/**
 * Right mouse button: a drag beyond this radius (CSS px) between press
 * and release is camera navigation (pan/orbit), not a menu request.
 */
export const RIGHT_CLICK_MOVE_PX = 5;

/**
 * Right mouse button: a press held longer than this (ms) is a
 * press-and-hold navigation gesture, not a click.
 */
export const RIGHT_CLICK_MAX_MS = 500;

/**
 * The context toolbar opens only for a real right CLICK: released
 * close to where it was pressed and without a long hold. Anything else
 * (right-drag to pan, press-and-hold) is navigation and must not pop
 * the toolbar when the button is released.
 */
export function isRightClick(gesture: {
  dx: number;
  dy: number;
  durationMs: number;
}): boolean {
  const { dx, dy, durationMs } = gesture;
  return (
    Math.hypot(dx, dy) <= RIGHT_CLICK_MOVE_PX &&
    durationMs <= RIGHT_CLICK_MAX_MS
  );
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

/** Convert `getAllModelExpressIds()`'s number[] values to ReadonlySet. */
export function toAllIdsMap(
  ids: ReadonlyMap<string, readonly number[]>,
): AllIdsMap {
  const out = new Map<string, ReadonlySet<number>>();
  for (const [modelId, list] of ids) {
    out.set(modelId, new Set(list));
  }
  return out;
}

/**
 * Hide selected: one `visible=false` op per selected model.
 * (Empty models in the selection are skipped.)
 */
export function computeHideSelectedOps(selection: SelectionMap): VisibilityOp[] {
  const ops: VisibilityOp[] = [];
  for (const [modelId, ids] of selection) {
    if (ids.size > 0) ops.push({ modelId, ids, visible: false });
  }
  return ops;
}

/**
 * Show all: one `visible=true` op per loaded model, touching every
 * geometry-bearing local ID (the "reset filter" semantics).
 */
export function computeShowAllOps(allIds: AllIdsMap): VisibilityOp[] {
  const ops: VisibilityOp[] = [];
  for (const [modelId, ids] of allIds) {
    if (ids.size > 0) ops.push({ modelId, ids, visible: true });
  }
  return ops;
}

/**
 * Isolate selected: for each loaded model, hide the complement
 * (all local IDs − selected IDs); for models that own part of the
 * selection, also explicitly keep the selected IDs visible. A model
 * with no selection entries is fully hidden (complement = all).
 */
export function computeIsolateSelectedOps(
  selection: SelectionMap,
  allIds: AllIdsMap,
): VisibilityOp[] {
  const ops: VisibilityOp[] = [];
  for (const [modelId, all] of allIds) {
    const selected = selection.get(modelId) ?? EMPTY_SET;
    const complement = new Set<number>();
    for (const id of all) {
      if (!selected.has(id)) complement.add(id);
    }
    if (complement.size > 0) {
      ops.push({ modelId, ids: complement, visible: false });
    }
    if (selected.size > 0) {
      ops.push({ modelId, ids: selected, visible: true });
    }
  }
  return ops;
}

/**
 * Find the IFC class whose id-set contains `expressId` in a single
 * model's inverted index. Reads the `_IfcClass` key first (the synthetic
 * property `flattenItemData` now emits); falls back to `_category` — the
 * raw TOE key — for indices built before the Wave-48 mirror. Returns
 * `null` when the index is missing or has no class entry for that element.
 */
export function findClassInIndex(
  index: InvertedIndex | undefined,
  expressId: number,
): string | null {
  if (!index) return null;
  for (const key of ["_IfcClass", "_category"]) {
    const valuesMap = index.get(key);
    if (!valuesMap) continue;
    for (const [value, ids] of valuesMap) {
      if (ids.has(expressId)) return value;
    }
  }
  return null;
}

/**
 * Local IDs in one model whose `_IfcClass` (or `_category`) equals
 * `ifcClass`. Empty when the model's index is missing or has no such class.
 */
export function classIdsForModel(
  index: InvertedIndex | undefined,
  ifcClass: string,
): ReadonlySet<number> {
  if (!index) return EMPTY_SET;
  for (const key of ["_IfcClass", "_category"]) {
    const valuesMap = index.get(key);
    if (!valuesMap) continue;
    const ids = valuesMap.get(ifcClass);
    if (ids) return ids;
  }
  return EMPTY_SET;
}

/**
 * Map every indexed model to the set of local IDs whose class equals
 * `ifcClass` (models with no such class are omitted). This is the map
 * `manualVisibilityStore.isolateTo(...)` consumes for isolate-category.
 */
export function computeCategoryClassMap(
  ifcClass: string,
  indices: ReadonlyMap<string, InvertedIndex>,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  if (!ifcClass) return out;
  for (const [modelId, index] of indices) {
    const classIds = classIdsForModel(index, ifcClass);
    if (classIds.size > 0) {
      out.set(modelId, new Set(classIds));
    }
  }
  return out;
}

/**
 * Build hide/isolate-category visibility ops across every loaded model.
 *
 *   - isolate=false (hide category): hide each model's class-members.
 *   - isolate=true (isolate category): hide the complement of the class
 *     set and keep the class members visible.
 *
 * A model whose index hasn't been built yet has no known class members,
 * so isolate hides it entirely (defensible "hide everything except that
 * class" semantics).
 */
export function computeCategoryOps(
  ifcClass: string,
  indices: ReadonlyMap<string, InvertedIndex>,
  allIds: AllIdsMap,
  isolate: boolean,
): VisibilityOp[] {
  const ops: VisibilityOp[] = [];
  if (!ifcClass) return ops;
  for (const [modelId, all] of allIds) {
    const classIds = classIdsForModel(indices.get(modelId), ifcClass);
    if (isolate) {
      const complement = new Set<number>();
      for (const id of all) {
        if (!classIds.has(id)) complement.add(id);
      }
      if (complement.size > 0) {
        ops.push({ modelId, ids: complement, visible: false });
      }
      if (classIds.size > 0) {
        ops.push({ modelId, ids: classIds, visible: true });
      }
    } else if (classIds.size > 0) {
      ops.push({ modelId, ids: classIds, visible: false });
    }
  }
  return ops;
}

export interface CategoryResolution {
  /** The resolved IFC class string, or null when resolution failed. */
  cls: string | null;
  /** Which path produced the class (or would have). */
  path: "index" | "getElementData" | "failed";
}

/**
 * Resolve the IFC class of the first selected element. Prefers the
 * per-model property index (`_IfcClass` / `_category` value-set); falls
 * back to the async `getElementData(...)["_IfcClass"] ?? ["_category"]`
 * when the index is unavailable for that model or lacks the element.
 * Reports the resolution path for the `[SCT]` telemetry breadcrumb in
 * `SelectionContextToolbar.handleCategory`.
 */
export async function resolveCategoryClass(
  selection: SelectionMap,
  indices: ReadonlyMap<string, InvertedIndex>,
  getElementData: (
    modelId: string,
    expressId: number,
  ) => Promise<Record<string, string> | null>,
): Promise<CategoryResolution> {
  const first = selection.entries().next();
  if (first.done) return { cls: null, path: "failed" };
  const [modelId, ids] = first.value as [string, ReadonlySet<number>];
  const firstId = ids.values().next().value as number | undefined;
  if (firstId === undefined) return { cls: null, path: "failed" };

  const fromIndex = findClassInIndex(indices.get(modelId), firstId);
  if (fromIndex) return { cls: fromIndex, path: "index" };

  const data = await getElementData(modelId, firstId);
  const fromData = data?.["_IfcClass"] ?? data?.["_category"] ?? null;
  if (fromData) return { cls: fromData, path: "getElementData" };
  return { cls: null, path: "failed" };
}

/** Rectangle passed into `clampPosition`. */
export interface ClampRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Size passed into `clampPosition`. */
export interface ClampSize {
  width: number;
  height: number;
}

/**
 * Convert clientX/clientY → container-relative CSS px and clamp so the
 * (estimated) toolbar stays fully inside the container. `margin` is the
 * inset from each edge (default 6px).
 */
export function clampPosition(opts: {
  clientX: number;
  clientY: number;
  rect: ClampRect;
  size: ClampSize;
  margin?: number;
}): { x: number; y: number } {
  const margin = opts.margin ?? 6;
  const relX = opts.clientX - opts.rect.left;
  const relY = opts.clientY - opts.rect.top;
  const maxX = Math.max(margin, opts.rect.width - opts.size.width - margin);
  const maxY = Math.max(margin, opts.rect.height - opts.size.height - margin);
  return {
    x: Math.min(Math.max(relX, margin), maxX),
    y: Math.min(Math.max(relY, margin), maxY),
  };
}

/** Plain world-space vector (drift-clean, no THREE import). */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** True for a finite, non-zero vector (safe to normalize against). */
function isFiniteUnit(v: Vec3Like | null | undefined): v is Vec3Like {
  if (!v) return false;
  if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.z)) {
    return false;
  }
  return Math.hypot(v.x, v.y, v.z) > 1e-9;
}

/**
 * Nearest axis-aligned bbox face normal for the given camera view
 * direction. `BoundingBoxer` boxes are axis-aligned, so their faces are
 * the six world axes; this returns the unit axis (±x/±y/±z) whose
 * direction best aligns with the view direction (the face the section
 * plane snaps parallel to when no picked face normal is available).
 * Returns null only for a degenerate direction.
 */
export function snapBboxFaceNormal(
  cameraDirection: Vec3Like,
): Vec3Like | null {
  if (!isFiniteUnit(cameraDirection)) return null;
  const ax = Math.abs(cameraDirection.x);
  const ay = Math.abs(cameraDirection.y);
  const az = Math.abs(cameraDirection.z);
  if (ax >= ay && ax >= az) {
    return { x: cameraDirection.x >= 0 ? 1 : -1, y: 0, z: 0 };
  }
  if (ay >= az) {
    return { x: 0, y: cameraDirection.y >= 0 ? 1 : -1, z: 0 };
  }
  return { x: 0, y: 0, z: cameraDirection.z >= 0 ? 1 : -1 };
}

/**
 * Resolve the section-plane normal for the right-click toolbar using the
 * Wave-48 face-normal-first chain:
 *
 *   1. picked face normal (flipped so the plane cuts TOWARD the camera —
 *      the visible half is the one the user looks at, matching the bottom
 *      toolbar's `target − eye` view-direction convention);
 *   2. bbox-face snap (nearest axis-aligned face to the view direction);
 *   3. camera view direction (last resort — the pre-wave-48 behavior).
 */
export function resolveSectionPlaneNormal(opts: {
  faceNormal?: Vec3Like | null;
  cameraDirection: Vec3Like;
}): Vec3Like {
  const face = opts.faceNormal;
  if (isFiniteUnit(face)) {
    // The picked face normal points OUT of the surface (toward the camera
    // for a front face); negate it so the Clipper removes the camera-side
    // half and reveals the interior — the same direction the bottom
    // toolbar's view-direction cut uses.
    return { x: 0 - face.x, y: 0 - face.y, z: 0 - face.z };
  }
  const snapped = snapBboxFaceNormal(opts.cameraDirection);
  if (snapped) return snapped;
  return {
    x: opts.cameraDirection.x,
    y: opts.cameraDirection.y,
    z: opts.cameraDirection.z,
  };
}