// src/picking/anchorScissor.ts
//
// Wave 28 W1b — narrow the DEPTH pass, the same way W1 narrowed the id
// pass.
//
// Why this file is separate: the anchor pass is not ours to reimplement.
// `FastModelPicker.getPointAt` renders full-frame (`renderDepthPass` →
// `renderWithTileMaterial`, `@thatopen/components` index.mjs:12950+),
// reads one pixel back, then decodes it with private module-level
// helpers (`unpackDepthFromRGBA`, `unprojectToWorld`) that are not
// exported at all. Re-deriving that math in the seam would be a second
// implementation to keep correct, for no gain.
//
// So this does the minimum: it writes the scissor ON THE TARGET and calls
// TOE's own `getPointAt`. Binding a target makes three reinstate that
// target's own `scissor` / `scissorTest` into GL state
// (`three.module.js:18424`, applied at `:18452`), so the clear + render
// inside TOE's call are clipped without us touching its render, readback,
// decode or unprojection. The readback is not scissored, so the pixel TOE
// reads is the pixel it would always have read.
//
// Trust model, identical to the id pass: the boxed result is compared
// against an unboxed control on the first click, and any disagreement
// turns the scissor off for the life of the picker. A scissor that clips
// the geometry it should have kept produces a NULL point, and a null point
// silently degrades tap-to-create to the bbox centre — the exact class of
// wrong-anchor bug this codebase has already been bitten by (wave 20).

import type { NdcPoint, WorldPoint } from "./pickTypes";

/** The subset of the picker this needs. */
interface AnchorTarget {
  _renderTarget?: {
    width?: number;
    height?: number;
    scissorTest?: boolean;
    scissor?: {
      x?: number;
      y?: number;
      z?: number;
      w?: number;
      set?: (x: number, y: number, w: number, h: number) => void;
    };
  };
  _renderTargetSize?: { x?: number; y?: number };
}

interface AnchorPicker extends AnchorTarget {
  getPointAt(
    position?: { x: number; y: number },
  ): Promise<WorldPoint | null>;
}

/** Slack around the single anchor pixel — see SCISSOR_PAD_PX in the seam. */
const ANCHOR_PAD_PX = 2;

/** Probation state per picker instance. */
const probation = new WeakMap<
  object,
  { mode: "pending" | "on" | "off" }
>();

function samePoint(a: WorldPoint | null, b: WorldPoint | null): boolean {
  if (a === null || b === null) return a === b;
  // Exact equality is the right bar here: the same pixel of the same
  // scene through the same matrices must produce the same numbers.
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function targetScissor(picker: AnchorTarget) {
  const t = picker._renderTarget;
  if (!t || typeof t.scissor?.set !== "function") return null;
  const size = picker._renderTargetSize;
  if (!size || typeof size.x !== "number" || typeof size.y !== "number") {
    return null;
  }
  if (size.x <= 0 || size.y <= 0) return null;
  return { target: t, size: { x: size.x, y: size.y } };
}

/**
 * Apply a probe-pixel-centred scissor to the target, returning a restore
 * closure. Null when the target cannot honour it (⇒ caller runs plain).
 */
function clipAround(
  picker: AnchorTarget,
  ndc: NdcPoint,
): null | (() => void) {
  const ctx = targetScissor(picker);
  if (!ctx) return null;
  const { target, size } = ctx;
  const scissor = target.scissor;
  if (!scissor || typeof scissor.set !== "function") return null;
  const px = Math.floor((ndc.x + 1) * 0.5 * size.x);
  const py = Math.floor((ndc.y + 1) * 0.5 * (size.y - 1));
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  const cx = Math.max(0, Math.min(size.x - 1, px));
  const cy = Math.max(0, Math.min(size.y - 1, py));
  const x = Math.max(0, cx - ANCHOR_PAD_PX);
  const y = Math.max(0, cy - ANCHOR_PAD_PX);
  const w = Math.min(size.x, cx + ANCHOR_PAD_PX + 1) - x;
  const h = Math.min(size.y, cy + ANCHOR_PAD_PX + 1) - y;
  if (w <= 0 || h <= 0) return null;

  const setBox = scissor.set.bind(scissor);
  const prev = { x: scissor.x, y: scissor.y, z: scissor.z, w: scissor.w };
  const prevTest = target.scissorTest === true;
  setBox(x, y, w, h);
  target.scissorTest = true;
  return () => {
    target.scissorTest = prevTest;
    if (
      prev.x !== undefined &&
      prev.y !== undefined &&
      prev.z !== undefined &&
      prev.w !== undefined
    ) {
      setBox(prev.x, prev.y, prev.z, prev.w);
    }
  };
}

export interface AnchorResult {
  point: WorldPoint | null;
  /** the depth pass was clipped to the anchor region for this call */
  clipped: boolean;
  /** this call also paid the unclipped control render to prove the clip */
  verified: boolean;
}

/**
 * `FastModelPicker.getPointAt`, with the depth render clipped to the
 * anchor pixel and a one-time control comparison guarding the clip.
 *
 * Returns `null`-safe results: on any disagreement the unclipped (control)
 * answer is the one reported, exactly like the id pass.
 */
export async function pickAnchorClipped(
  picker: AnchorPicker | null | undefined,
  ndc: NdcPoint,
): Promise<AnchorResult> {
  if (!picker || typeof picker.getPointAt !== "function") {
    return { point: null, clipped: false, verified: false };
  }
  const state = probation.get(picker) ?? { mode: "pending" as const };
  probation.set(picker, state);

  if (state.mode === "off") {
    return { point: await picker.getPointAt(ndc), clipped: false, verified: false };
  }

  const restore = clipAround(picker, ndc);
  if (!restore) {
    // Nothing to clip with: don't pretend, and don't burn a proof.
    state.mode = "off";
    return { point: await picker.getPointAt(ndc), clipped: false, verified: false };
  }

  let clipped: WorldPoint | null;
  try {
    clipped = await picker.getPointAt(ndc);
  } finally {
    restore();
  }

  if (state.mode === "on") {
    return { point: clipped, clipped: true, verified: false };
  }

  // Pending: compare against the unclipped control render. Clipped-NULL
  // versus unclipped-point is the failure this exists to catch — a silent
  // null would send tap-to-create to the bbox centre and look like the
  // wave-20 bug all over again.
  const control = await picker.getPointAt(ndc);
  if (samePoint(clipped, control)) {
    if (control !== null) {
      // Agreement on a real point proves it; agreement on two nulls proves
      // nothing (a void pixel reads void either way), so stay pending.
      state.mode = "on";
    }
    return { point: clipped, clipped: true, verified: true };
  }
  state.mode = "off";
  return { point: control, clipped: false, verified: true };
}

/** Test seam: how many pickers are currently on probation. */
export function anchorClipMode(
  picker: object,
): "pending" | "on" | "off" | undefined {
  return probation.get(picker)?.mode;
}
