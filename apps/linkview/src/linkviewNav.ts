// apps/linkview/src/linkviewNav.ts
//
// Wave 57 — pure navigation-view math for the LinkView "you are
// here" layer. No React, no DOM, no engine imports: only the
// calibration similarity transform (reused, not forked) and plain
// point shapes. Everything here is unit-testable in plain Node.
//
// The transform lives in packages/ff-data/src/calibration/similarity.ts
// (`applyCalibration` PDF → world, `invertCalibration` world → PDF).
// We deliberately do NOT re-derive that math here — the marker↔camera
// linkage is a thin wrapper so 2D PDF coords and 3D-floor-plan coords
// stay locked through the single source of truth.

import {
  applyCalibration,
  invertCalibration,
} from "@ff/data/calibration/similarity";
import type {
  CalibrationRecord,
  CalibrationTransformParams,
} from "@ff/types";
import type { ViewerPose } from "@ff/viewer-react";

/** Fallback FOV when the current pose can't be read (persp default). */
export const DEFAULT_CAMERA_FOV = 45;
/** Plan-distance threshold (metres) below which a camera move does not
 *  count as a real navigation (guards against noise + feedback). */
export const CAMERA_SYNC_EPSILON = 0.02;
/**
 * Horizontal plan-vector magnitude (metres) below which a camera
 * pose's look direction is considered vertical and its azimuth is
 * therefore degenerate (any bearing is as good as another). Live
 * bearing updates must HOLD their last valid value in this case.
 * The first-person nav camera clamps pitch to ±60°, so its horizontal
 * component (≥ LOOK_DISTANCE·cos 60° = 0.5 m) never trips this.
 */
export const CAMERA_AZIMUTH_EPSILON = 0.05;

/** 2D point in PDF page coords (points, y-down) — same shape as the
 *  wizard's click handler reports. */
export interface PdfPoint {
  x: number;
  y: number;
}

/** 2D point in world floor-plan coords (X-Z plane, Y is up). */
export interface WorldPoint {
  x: number;
  z: number;
}

/** The calibration's first anchor as a PDF page point (the seed). */
export function seedPdfPoint(record: CalibrationRecord): PdfPoint {
  const p = record.pointPairs[0];
  return { x: p.pdfX, y: p.pdfY };
}

/** The calibration's first anchor as a world floor-plan point. */
export function seedWorldPoint(record: CalibrationRecord): WorldPoint {
  const p = record.pointPairs[0];
  return { x: p.worldX, z: p.worldZ };
}

// ── First-person navigation (the right pane's "you are here" camera) ──
//
// The LinkView nav camera is a FIRST-PERSON, eye-level camera (the
// Task-21 walk-through behaviour): it stands at the marker's world
// point on the mapped storey, `EYE_HEIGHT` above the floor, and looks
// (near-)horizontally along the marker bearing. Wave 58 had replaced
// it with a straight-down camera at the level-plan framing height,
// which made the right pane read as a second top-down plan.
//
// Conventions (shared with the marker cone):
//   - world plan axes are X / Z, +Y is up;
//   - bearing = atan2(dz, dx) — counter-clockwise from +X around +Y in
//     the maths sense, which viewed from above (+Z down the screen)
//     turns from +X toward +Z; turning RIGHT increases the bearing;
//   - pitch = elevation angle of the look direction (+ = look up).

/** Eye height above the storey's floor elevation, in metres. */
export const EYE_HEIGHT = 1.65;
/** Eye → target distance (metres). camera-controls orbits around the
 *  target, so a short distance keeps a drag-look feeling like turning
 *  the head rather than circling a far point. */
export const LOOK_DISTANCE = 1;
/** Max |pitch| (radians, 60°) so the look never degenerates. */
export const MAX_PITCH = (60 * Math.PI) / 180;
/** Drag-to-look sensitivity, radians per CSS pixel. */
export const LOOK_SENSITIVITY = 0.004;
/** Walking speed (m/s) and the Shift "run" multiplier. */
export const WALK_SPEED = 2.5;
export const RUN_MULTIPLIER = 2.5;

/** Unit look direction for a bearing + pitch. */
export function lookDirection(
  bearing: number,
  pitch: number,
): [number, number, number] {
  const cp = Math.cos(pitch);
  return [cp * Math.cos(bearing), Math.sin(pitch), cp * Math.sin(bearing)];
}

/**
 * First-person nav pose: eye at the world point `EYE_HEIGHT` above
 * `floorZ`, looking along `bearing` (horizontal when `pitch` = 0).
 * Always perspective (a first-person view has no ortho variant); the
 * fov is inherited from a perspective `currentPose`, else 45°.
 */
export function firstPersonPose(
  point: WorldPoint,
  floorZ: number,
  bearing: number,
  pitch: number,
  currentPose: ViewerPose | null,
  eyeHeight: number = EYE_HEIGHT,
): ViewerPose {
  const eyeY = floorZ + eyeHeight;
  const p = clampPitch(pitch);
  const [dx, dy, dz] = lookDirection(bearing, p);
  return {
    pos: [point.x, eyeY, point.z],
    target: [
      point.x + dx * LOOK_DISTANCE,
      eyeY + dy * LOOK_DISTANCE,
      point.z + dz * LOOK_DISTANCE,
    ],
    fov:
      currentPose && !currentPose.isOrtho
        ? currentPose.fov
        : DEFAULT_CAMERA_FOV,
    isOrtho: false,
  };
}

/** Clamp a pitch to ±MAX_PITCH. */
export function clampPitch(pitch: number): number {
  return Math.min(Math.max(pitch, -MAX_PITCH), MAX_PITCH);
}

/** Look pitch (radians) of a pose; 0 when eye and target coincide. */
export function pitchFromPose(pose: ViewerPose): number {
  const dx = pose.target[0] - pose.pos[0];
  const dy = pose.target[1] - pose.pos[1];
  const dz = pose.target[2] - pose.pos[2];
  const h = Math.hypot(dx, dz);
  if (h === 0 && dy === 0) return 0;
  return Math.atan2(dy, h);
}

/**
 * Apply a drag-look delta (CSS pixels). Video-game convention: drag
 * right → turn right (bearing grows), drag up → look up.
 */
export function applyLookDelta(
  look: { bearing: number; pitch: number },
  dxPx: number,
  dyPx: number,
  sensitivity: number = LOOK_SENSITIVITY,
): { bearing: number; pitch: number } {
  return {
    bearing: look.bearing + dxPx * sensitivity,
    pitch: clampPitch(look.pitch - dyPx * sensitivity),
  };
}

/** Walk intent from the held key codes (WASD + arrows). */
export interface WalkInput {
  /** +1 forward, −1 back. */
  forward: number;
  /** +1 strafe right, −1 strafe left. */
  right: number;
}

const FORWARD_KEYS = ["KeyW", "ArrowUp"];
const BACK_KEYS = ["KeyS", "ArrowDown"];
const LEFT_KEYS = ["KeyA", "ArrowLeft"];
const RIGHT_KEYS = ["KeyD", "ArrowRight"];

/** Every key code the first-person walk controller consumes. */
export const WALK_KEY_CODES: ReadonlySet<string> = new Set([
  ...FORWARD_KEYS,
  ...BACK_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
]);

export function walkInputFromKeys(keys: ReadonlySet<string>): WalkInput {
  const has = (codes: string[]): boolean => codes.some((c) => keys.has(c));
  return {
    forward: (has(FORWARD_KEYS) ? 1 : 0) - (has(BACK_KEYS) ? 1 : 0),
    right: (has(RIGHT_KEYS) ? 1 : 0) - (has(LEFT_KEYS) ? 1 : 0),
  };
}

/**
 * Horizontal plan displacement for one walk step: `distance` metres
 * along the bearing-relative input, diagonals normalised. Walking
 * never changes height (the caller pins the eye to the storey).
 */
export function walkDelta(
  bearing: number,
  input: WalkInput,
  distance: number,
): { dx: number; dz: number } {
  const fx = Math.cos(bearing);
  const fz = Math.sin(bearing);
  // right = forward × up = (−sin b, 0, cos b)
  const rx = -Math.sin(bearing);
  const rz = Math.cos(bearing);
  let x = fx * input.forward + rx * input.right;
  let z = fz * input.forward + rz * input.right;
  const mag = Math.hypot(x, z);
  if (mag === 0) return { dx: 0, dz: 0 };
  x /= mag;
  z /= mag;
  return { dx: x * distance, dz: z * distance };
}

/** Minimal event-target shape for {@link isEditableTarget}. */
export interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True when keyboard input on `target` is text entry (inputs,
 *  textareas, selects, contenteditable) — walking must ignore it. */
export function isEditableTarget(target: EditableLike | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * World bearing → the marker cone's angle on the PDF page. The
 * calibration is `world = s·R(θ)·pdf + t` (PDF y-down, no mirror), so
 * a PDF direction at angle φ lands at world bearing φ + θ. The cone is
 * drawn with SVG `rotate(φ)` (clockwise on a y-down page = the same
 * maths angle in page coords), so it must use φ = bearing − θ.
 */
export function pdfBearingFromWorld(
  params: CalibrationTransformParams,
  bearing: number,
): number {
  return bearing - params.rotation;
}

/** Inverse of {@link pdfBearingFromWorld}. */
export function worldBearingFromPdf(
  params: CalibrationTransformParams,
  pdfBearing: number,
): number {
  return pdfBearing + params.rotation;
}

/**
 * Seed bearing (radians) — the direction from the nav point toward
 * the model centroid, `atan2(centroid.z − z, centroid.x − x)`,
 * measured counter-clockwise from +X around +Y (the Three.js
 * right-hand rule with +Y up). Returns 0 when the centroid is
 * unknown so the marker always has a well-defined initial cone.
 */
export function bearingTowardCentroid(
  point: WorldPoint,
  centroid: { x: number; z: number } | null,
): number {
  if (!centroid) return 0;
  return Math.atan2(centroid.z - point.z, centroid.x - point.x);
}

/**
 * Live camera bearing (radians) from a pose's horizontal look
 * component `atan2(target[2] − pos[2], target[0] − pos[0])`. Returns
 * null when that horizontal magnitude is below `CAMERA_AZIMUTH_EPSILON`
 * — straight-down poses have a degenerate azimuth, and callers must
 * HOLD their last valid bearing instead. Relies on `getPose()` returning
 * the real controls target (fixed in 8a8dc1e — before that the target
 * always read back as the origin, so this pointed at [0,0,0]).
 */
export function bearingFromPose(pose: ViewerPose): number | null {
  const dx = pose.target[0] - pose.pos[0];
  const dz = pose.target[2] - pose.pos[2];
  if (Math.hypot(dx, dz) < CAMERA_AZIMUTH_EPSILON) return null;
  return Math.atan2(dz, dx);
}

/** Bearing change (radians, ≈0.5°) below which the live marker
 *  bearing is not updated — a sub-pixel cone rotation is invisible,
 *  and skipping it avoids a React render per animation frame. */
export const BEARING_EPSILON = (0.5 * Math.PI) / 180;

/**
 * True when `next` differs from `prev` by more than `epsilon`
 * radians, measured as the shortest angular distance (so −π and +π
 * are the same direction, not 2π apart).
 */
export function bearingChanged(
  prev: number,
  next: number,
  epsilon: number = BEARING_EPSILON,
): boolean {
  const diff = Math.abs(
    Math.atan2(Math.sin(next - prev), Math.cos(next - prev)),
  );
  return diff > epsilon;
}

/** PDF → world floor-plan point (forward similarity map). */
export function worldFromPdfPoint(
  params: CalibrationTransformParams,
  pdf: PdfPoint,
): WorldPoint {
  return applyCalibration(params, { x: pdf.x, y: pdf.y });
}

/** World floor-plan point → PDF page point (inverse similarity map). */
export function pdfFromWorldPoint(
  params: CalibrationTransformParams,
  world: WorldPoint,
): PdfPoint {
  const p = invertCalibration(params, world);
  return { x: p.x, y: p.y };
}

/**
 * Clamp a PDF point to the page bounds so the marker never flies off
 * the sheet. `pageWidth` / `pageHeight` are in PDF points; when they
 * are missing (≤ 0) the point is returned unchanged.
 */
export function clampPdfPoint(
  point: PdfPoint,
  pageWidth: number,
  pageHeight: number,
): PdfPoint {
  if (pageWidth <= 0 || pageHeight <= 0) return point;
  return {
    x: Math.min(Math.max(point.x, 0), pageWidth),
    y: Math.min(Math.max(point.y, 0), pageHeight),
  };
}

/**
 * Canvas-local CSS-pixel position of the marker inside the PDF's
 * annotation layer. The layer is a pre-CSS-transform sibling of the
 * canvas (sized `pageWidth × renderScale`), so the multiplier is the
 * RENDER scale — NOT `getTotalScale()` (renderScale × displayScale),
 * because `.pv-zoom-transform` already applies the display scale on
 * top of this. This matches the calibration wizard's marker math.
 */
export function markerCssPosition(
  point: PdfPoint,
  renderScale: number,
): { left: number; top: number } {
  return { left: point.x * renderScale, top: point.y * renderScale };
}

/** Minimal client rect shape (subset of DOMRect) for testability. */
export interface ClientRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Convert a browser client point to PDF page coords from the
 * annotation layer's (post-transform) visual rect and the viewer's
 * total scale. `rect.width / totalScale` recovers the page-width in
 * points, exactly like the viewer's own `pageCoordsFromEvent`.
 *
 * Returns null when the rect is degenerate (jsdom, not yet laid out)
 * or the scale is zero.
 */
export function pageCoordsFromClientRect(
  rect: ClientRectLike,
  totalScale: number,
  clientX: number,
  clientY: number,
): PdfPoint | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  if (!Number.isFinite(totalScale) || totalScale <= 0) return null;
  return {
    x: (clientX - rect.left) / totalScale,
    y: (clientY - rect.top) / totalScale,
  };
}

/**
 * One-source-of-truth guard for the 3D → PDF back-projection. The
 * back-projection (camera-move → marker-follow) is allowed only when
 * nav is active AND the user is not mid-drag on the marker. While the
 * marker is being dragged the marker drives the camera; the camera→
 * marker direction is suppressed so the two never fight.
 */
export function shouldBackProjectCamera(
  dragging: boolean,
  navActive: boolean,
): boolean {
  return navActive && !dragging;
}

/** Plan-space (X-Z) distance between two world points, in metres. */
export function planDistance(a: WorldPoint, b: WorldPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}
// ── Storey floor elevation (eye-height anchor) ──────────────────────
//
// `StoreyRecord.elevation` is the raw `IfcBuildingStorey.Elevation`
// in the model's length unit. The viewer geometry is in metres, so a
// millimetre model would put the eye 3000 m above a 3 m floor. No
// unit is stored with the storey yet (follow-up for ff-data), so the
// scale is inferred per IFC version from its own storey elevations.

/** Median storey spacing at or above which elevations are read as mm.
 *  No real building has storeys ≥ 1 km apart; mm storeys are ~3000. */
export const MM_STOREY_GAP_THRESHOLD = 1000;
/** Single-storey fallback: |elevation| at or above which a value with
 *  no centroid to compare against is read as mm. */
export const MM_SINGLE_ELEVATION_THRESHOLD = 10000;

/**
 * Length-unit → metre factor for one model's storey elevations:
 * `0.001` for millimetres, else `1`. With ≥ 2 distinct storeys the
 * median spacing decides. With one storey it picks the reading closer
 * to the model centroid height (`centroidY`, world metres) when known.
 */
export function inferElevationUnitScale(
  elevations: readonly number[],
  centroidY?: number | null,
): number {
  const values = Array.from(
    new Set(elevations.filter((e) => Number.isFinite(e))),
  ).sort((a, b) => a - b);
  if (values.length === 0) return 1;
  if (values.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < values.length; i += 1) {
      gaps.push(values[i] - values[i - 1]);
    }
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const median =
      gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    return median >= MM_STOREY_GAP_THRESHOLD ? 0.001 : 1;
  }
  const e = values[0];
  if (centroidY !== undefined && centroidY !== null && Number.isFinite(centroidY)) {
    return Math.abs(e * 0.001 - centroidY) < Math.abs(e - centroidY) ? 0.001 : 1;
  }
  return Math.abs(e) >= MM_SINGLE_ELEVATION_THRESHOLD ? 0.001 : 1;
}

/** The StoreyRecord fields the floor-Z resolver reads. */
export interface StoreyElevationRow {
  name: string;
  elevation: number;
  ifcVersionId: string;
  sourceIfcFileId: string;
}

export interface ResolveFloorZOptions {
  /** Current (latest) IFC version ids of the building. Rows of older
   *  versions are ignored when at least one current row exists. */
  currentVersionIds?: ReadonlySet<string> | null;
  /** Prefer this model's storey (e.g. the open level's IFC file). */
  preferredIfcFileId?: string | null;
  /** Model centroid height (world metres) for the unit tie-break. */
  centroidY?: number | null;
}

/**
 * Floor elevation (world metres) of the storey `storeyName` in a
 * (possibly federated) building, or `null` when no model has it.
 *
 *   - only current IFC versions count (stale versions keep old rows);
 *   - the preferred model wins when it has the storey;
 *   - each candidate is converted with ITS model's unit scale;
 *   - among several models the lowest floor wins (the level plan's
 *     "lowest elevation wins" rule, so both panes agree).
 */
export function resolveStoreyFloorZ(
  storeyName: string,
  rows: readonly StoreyElevationRow[],
  options: ResolveFloorZOptions = {},
): number | null {
  let pool: readonly StoreyElevationRow[] = rows;
  const current = options.currentVersionIds;
  if (current && current.size > 0) {
    const live = rows.filter((r) => current.has(r.ifcVersionId));
    if (live.length > 0) pool = live;
  }
  let matches = pool.filter((r) => r.name === storeyName);
  if (matches.length === 0) return null;
  if (options.preferredIfcFileId) {
    const preferred = matches.filter(
      (r) => r.sourceIfcFileId === options.preferredIfcFileId,
    );
    if (preferred.length > 0) matches = preferred;
  }
  let best: number | null = null;
  for (const m of matches) {
    const siblings = pool
      .filter((r) => r.ifcVersionId === m.ifcVersionId)
      .map((r) => r.elevation);
    const z = m.elevation * inferElevationUnitScale(siblings, options.centroidY);
    if (best === null || z < best) best = z;
  }
  return best;
}
