// src/picking/pointerPick.ts
//
// Pure pointer -> pick-coordinate helpers (no engine, no DOM globals), so the
// math the tap pipeline depends on is unit-testable and shared by every call
// site.
//
// The invariant (wave 73): every pick coordinate is derived in CSS pixels
// relative to the canvas' bounding rect and normalised to NDC. NDC is
// independent of the renderer pixel ratio and of `window.devicePixelRatio`, so
// the same tap resolves to the same pick at 1x, 1.5x (a WebView host) or 0.75x
// (the engine's own "moving" ratio). Nothing here may multiply by a pixel
// ratio; the only place buffer pixels exist is `ndcToBufferPixel`, used for
// readbacks from a target whose size is already in buffer pixels.

/** Minimal `getBoundingClientRect()` shape. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Ndc {
  x: number;
  y: number;
}

/**
 * Client (CSS) pixel -> NDC (x right, y up, both in [-1, 1]) against the
 * canvas rect. Returns `null` for a degenerate rect or non-finite input.
 */
export function clientToNdc(
  rect: RectLike,
  clientX: number,
  clientY: number,
): Ndc | null {
  if (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    return null;
  }
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -(((clientY - rect.top) / rect.height) * 2 - 1),
  };
}

/**
 * NDC -> integer pixel inside a render target / drawing buffer of
 * `width` x `height` (clamped). Same flooring TOE's own readback uses; the
 * size passed in is whatever buffer is being read, never CSS pixels scaled by a
 * ratio the caller guessed.
 */
export function ndcToBufferPixel(
  ndc: Ndc,
  width: number,
  height: number,
): { x: number; y: number } | null {
  if (!(width > 0) || !(height > 0)) return null;
  if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
  const x = Math.floor((ndc.x + 1) * 0.5 * width);
  const y = Math.floor((ndc.y + 1) * 0.5 * height);
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
  };
}

/** Travel (CSS px) a press may move and still be a tap, by pointer kind. */
export const MOUSE_TAP_SLOP_PX = 5;
/**
 * A finger never holds still: platform tap slop is ~8-16 CSS px. With the
 * mouse threshold (5 px) a normal tap was classified as a drag and dropped.
 */
export const TOUCH_TAP_SLOP_PX = 12;

export function tapSlopPx(pointerType: string | undefined): number {
  return pointerType === "touch" || pointerType === "pen"
    ? TOUCH_TAP_SLOP_PX
    : MOUSE_TAP_SLOP_PX;
}

/** The slice of a PointerEvent the tracker reads. */
export interface PointerLike {
  pointerId?: number;
  pointerType?: string;
  button?: number;
  clientX: number;
  clientY: number;
}

export interface TapTracker {
  down(e: PointerLike): void;
  move(e: PointerLike): void;
  /** The press ended (pointerup). `moved` survives until `wasDrag()`. */
  up(e?: PointerLike): void;
  /** The browser took the gesture (pointercancel). Counts as a drag. */
  cancel(): void;
  /** Consume: true when the last gesture was a drag / multi-touch, not a tap. */
  wasDrag(): boolean;
}

/**
 * Drag-vs-tap discriminator. Pointer-type aware slop; a second simultaneous
 * pointer (pinch) or a cancel makes the gesture a drag. Only the primary
 * button starts a gesture.
 */
export function createTapTracker(): TapTracker {
  const s = {
    down: false,
    moved: false,
    id: -1,
    x: 0,
    y: 0,
    slop: MOUSE_TAP_SLOP_PX,
    active: new Set<number>(),
  };
  return {
    down(e) {
      if (e.pointerId !== undefined) s.active.add(e.pointerId);
      if (s.active.size > 1) {
        // Second finger: a pinch / two-finger pan, never a tap.
        s.moved = true;
        return;
      }
      if ((e.button ?? 0) !== 0) return;
      s.down = true;
      s.moved = false;
      s.id = e.pointerId ?? -1;
      s.x = e.clientX;
      s.y = e.clientY;
      s.slop = tapSlopPx(e.pointerType);
    },
    move(e) {
      if (!s.down || s.moved) return;
      if (e.pointerId !== undefined && s.id !== -1 && e.pointerId !== s.id) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > s.slop) s.moved = true;
    },
    up(e) {
      if (e?.pointerId !== undefined) s.active.delete(e.pointerId);
      else s.active.clear();
      s.down = false;
    },
    cancel() {
      s.active.clear();
      s.down = false;
      s.moved = true;
    },
    wasDrag() {
      const m = s.moved;
      s.moved = false;
      return m;
    },
  };
}

/** Anything with the engine `Mouse` feed method (OBC `Mouse`, picker, raycaster). */
export interface MouseFeedTarget {
  mouse?: { updateMouseInfo?: (e: Event) => void } | null;
}

/**
 * The engine's `Mouse` helper only listens to `pointermove` and `touchstart`.
 * A tap that produced neither before the pick (some WebViews deliver pointerdown
 * + pointerup + click only, or the first touch after a layout change) leaves the
 * engine's "last position" stale or unset, and every pick that falls back to it
 * reads the wrong pixel (or the screen centre). Feed it the pointer event
 * ourselves. Never throws: an engine shape drift just skips the feed.
 */
export function feedEngineMouse(
  targets: ReadonlyArray<MouseFeedTarget | null | undefined>,
  e: Event,
): void {
  for (const t of targets) {
    try {
      t?.mouse?.updateMouseInfo?.(e);
    } catch {
      // drift boundary
    }
  }
}

// ── Touch tolerance for the worker raycast ───────────────────────────
//
// The worker raycast is an exact ray-triangle test through ONE pixel. A mouse
// cursor is a point; a fingertip is ~40 CSS px wide and the tap lands a few
// pixels off what the user meant. On thin geometry (pipes, ducts, edges of
// slabs) the exact pixel misses and the viewer reported "empty space" while a
// neighbouring pixel hits. For touch / pen input a miss at the tap point is
// retried at a ring of points around it (one parallel round-trip).

/** Ring radius (CSS px) for touch tolerance. */
export const TOUCH_RAYCAST_RING_PX = 10;

/**
 * Probe offsets (CSS px) for a tolerant touch raycast, in priority order:
 * the four axis neighbours first, then the diagonals.
 */
export function touchProbeOffsets(radiusPx: number = TOUCH_RAYCAST_RING_PX): Array<{ dx: number; dy: number }> {
  const r = radiusPx;
  const d = r * Math.SQRT1_2;
  return [
    { dx: 0, dy: -r },
    { dx: r, dy: 0 },
    { dx: 0, dy: r },
    { dx: -r, dy: 0 },
    { dx: d, dy: -d },
    { dx: d, dy: d },
    { dx: -d, dy: d },
    { dx: -d, dy: -d },
  ];
}

interface RaycastDataLike {
  mouse?: { clone?: () => { x: number; y: number } } | null;
  [k: string]: unknown;
}

/**
 * Wrap a worker raycaster so a MISS at the exact point is retried around it
 * (all probes in parallel; the first hit in priority order wins). A hit at
 * the exact point is returned untouched, a rejection propagates (the seam
 * treats it as "fall back", never as a miss). Data without a cloneable
 * `mouse` is passed straight through.
 */
export function withTouchTolerance<R extends { raycast(data: unknown): Promise<unknown> }>(
  raycaster: R,
  radiusPx: number = TOUCH_RAYCAST_RING_PX,
): { raycast(data: unknown): Promise<unknown> } {
  return {
    async raycast(data: unknown): Promise<unknown> {
      const first = await raycaster.raycast(data);
      if (first) return first;
      const d = data as RaycastDataLike;
      const base = d?.mouse;
      if (!base || typeof base.clone !== "function") return first;
      const probes = touchProbeOffsets(radiusPx).map(({ dx, dy }) => {
        const m = base.clone!();
        m.x += dx;
        m.y += dy;
        return raycaster.raycast({ ...d, mouse: m });
      });
      const results = await Promise.all(probes);
      return results.find((r) => !!r) ?? first;
    },
  };
}
