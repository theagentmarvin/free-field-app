import type { Vec3 } from "./callouts";

/**
 * Pure helpers for the tap-to-create + marker (Wave 5B).
 *
 * No DOM, no viewer, no Firebase, no clock beyond the caller's own
 * timestamps — every export here is unit-testable in isolation. The
 * 3D marker anchors at the selection's bounding-box centre (bbox →
 * world point); the 2D marker distinguishes a tap from a drag before
 * the host records a uv; both feed the SAME `TaskLocation` shapes the
 * compose→outbox pipeline already expects (the trigger changed, the
 * payload builders did not).
 */

/** Axis-aligned world-space bounding box (the `THREE.Box3` shape, via
 *  the viewer's BoundingBoxer, reduced to plain numbers). */
export interface BBox {
  min: Vec3;
  max: Vec3;
}

/**
 * Screen-anchor math: a selection bbox → the anchor world point. The
 * marker pins to this point and projects it to screen each frame.
 */
export function bboxCenter(b: BBox): Vec3 {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

/** Max pointer travel (px) under which a gesture is a "tap", not a drag. */
export const TAP_MOVE_THRESHOLD_PX = 6;
/** Max press duration (ms) for a gesture to count as a "tap". */
export const TAP_MAX_DURATION_MS = 500;

/** A pointer-down stamp used for click-vs-drag discrimination. */
export interface PointerStamp {
  clientX: number;
  clientY: number;
  t: number;
}

/**
 * Click-vs-drag discriminator: a drag (pan/zoom) must NOT create or
 * move the marker. `true` only when the pointer lifted within ~6px of
 * where it pressed and within half a second.
 */
export function isTapClick(down: PointerStamp, up: PointerStamp): boolean {
  const dt = up.t - down.t;
  if (dt > TAP_MAX_DURATION_MS) return false;
  const dx = up.clientX - down.clientX;
  const dy = up.clientY - down.clientY;
  return Math.hypot(dx, dy) <= TAP_MOVE_THRESHOLD_PX;
}

/** 2D tap-marker state machine: shown / moved / cleared. */
export type TapMarkerState =
  | { kind: "hidden" }
  | { kind: "shown"; uv: [number, number] };

export type TapMarkerAction =
  | { type: "tap"; uv: [number, number] }
  | { type: "clear" };

/**
 * Reducer over the 2D marker. A `tap` shows the marker — a tap at a
 * NEW uv is the "moved" transition (next state is still `shown`, just
 * re-anchored); a `clear` hides it. Trivial and total: no thrown
 * paths, so the state machine is exhaustively testable.
 */
export function tapMarkerReducer(
  _state: TapMarkerState,
  action: TapMarkerAction,
): TapMarkerState {
  switch (action.type) {
    case "tap":
      return { kind: "shown", uv: action.uv };
    case "clear":
      return { kind: "hidden" };
  }
}