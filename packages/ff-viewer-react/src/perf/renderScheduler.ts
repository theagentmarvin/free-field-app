// packages/ff-viewer-react/src/perf/renderScheduler.ts
//
// Render-on-demand scheduler: decides, once per animation frame, whether
// the viewer's main render must run. Pure: no three.js, no engine imports.
//
// The OBC update loop keeps ticking every animation frame (camera-controls
// needs it), but with the SimpleRenderer in MANUAL mode the GPU draw only
// happens when `renderer.needsUpdate` is set. This module owns that flag's
// policy:
//
//   render this frame when ANY of
//     1. "always" mode (escape hatch: the pre-wave AUTO behaviour);
//     2. something invalidated the view since the last frame
//        (`invalidate(reason)` — camera events, tile application,
//        highlight/visibility/section changes, resize, input, ...);
//     3. the keep-alive window of the last invalidation is still open —
//        `keepAliveMs` AND at least `keepAliveFrames` frames (covers async
//        follow-ups that land a few frames later: worker round-trips,
//        materials compiled lazily, engine rAF callbacks; the frame count
//        matters when one frame compiles shaders for longer than the
//        time window);
//     4. a continuous source is active (`continuous()` returns a reason:
//        the camera is moving, a fragments model is streaming tiles, an
//        interactive tool is armed);
//     5. stale-frame guard: the view signature (camera pose, canvas size,
//        scene children, tile counts, clipping planes, ...) differs from
//        the one recorded after the last main render — a change nobody
//        invalidated. It is rendered anyway (self-heal) and reported via
//        `onStale` (dev warning / telemetry), so missing wiring shows up
//        instead of leaving a frozen, wrong picture on screen;
//     6. optional heartbeat: at most `heartbeatMs` without a render.
//
// Usage per animation frame (the glue does this):
//   const reason = scheduler.frame();       // before the renderer runs
//   if (reason) renderer.needsUpdate = true;
//   ... renderer.update() ... → scheduler.rendered() after a main render.

export type RenderMode = "on-demand" | "always";

/** A labelled view signature: part name → number. */
export type ViewSignature = Record<string, number>;

export interface StaleFrameInfo {
  /** Signature parts that changed without an invalidation. */
  changed: string[];
  /** Total stale frames detected so far (including this one). */
  count: number;
}

export interface RenderSchedulerOptions {
  /** "on-demand" (default) or "always" (render every frame). */
  mode?: RenderMode;
  /** Frames keep rendering for this long after an invalidation (ms). */
  keepAliveMs?: number;
  /**
   * ...and for at least this many frames, however long they take. A
   * frame that compiles shaders (new clipping plane, new material) can
   * outlast the whole time window; follow-ups still get their frames.
   */
  keepAliveFrames?: number;
  /** Render at least this often while idle (ms); 0 disables (default). */
  heartbeatMs?: number;
  now?: () => number;
  /** Reason to render continuously right now, or null. */
  continuous?: () => string | null;
  /** Cheap view signature for the stale-frame guard (null = skip). */
  signature?: () => ViewSignature | null;
  /** Called when the stale-frame guard fires. */
  onStale?: (info: StaleFrameInfo) => void;
  /**
   * Called synchronously on every invalidation, so a change made in the
   * middle of a frame (e.g. a camera-controls `update` event emitted
   * while the camera updates, BEFORE the renderer runs) still lands in
   * that same frame.
   */
  onInvalidate?: () => void;
}

export interface RenderSchedulerStats {
  mode: RenderMode;
  /** Animation frames seen by `frame()`. */
  frames: number;
  /** Main renders reported via `rendered()`. */
  renders: number;
  /** Frames that skipped the render. */
  skipped: number;
  invalidations: number;
  staleFrames: number;
  heartbeats: number;
  /** Render decisions per reason (dirty reason, "keepalive", "stale", ...). */
  byReason: Record<string, number>;
  lastReason: string | null;
}

export const RENDER_KEEPALIVE_MS = 300;
export const RENDER_KEEPALIVE_FRAMES = 3;

/** FNV-1a style 32-bit mix of a float, quantized to 1/4096. */
export function mixSignature(hash: number, value: number): number {
  const q = Number.isFinite(value) ? Math.round(value * 4096) : 0x7fffffff;
  return Math.imul(hash ^ q, 0x01000193);
}
export const SIGNATURE_SEED = 0x811c9dc5;

export class RenderScheduler {
  private _mode: RenderMode;
  private readonly keepAliveMs: number;
  private readonly keepAliveFrames: number;
  private keepAliveFramesLeft = 0;
  private readonly heartbeatMs: number;
  private readonly now: () => number;
  private readonly opts: RenderSchedulerOptions;
  private dirtyReason: string | null = null;
  private keepAliveUntil = -Infinity;
  private lastRenderAt = -Infinity;
  private lastSignature: ViewSignature | null = null;
  private _stats: RenderSchedulerStats;

  constructor(opts: RenderSchedulerOptions = {}) {
    this.opts = opts;
    this._mode = opts.mode ?? "on-demand";
    this.keepAliveMs = Math.max(0, opts.keepAliveMs ?? RENDER_KEEPALIVE_MS);
    this.keepAliveFrames = Math.max(0, opts.keepAliveFrames ?? RENDER_KEEPALIVE_FRAMES);
    this.heartbeatMs = Math.max(0, opts.heartbeatMs ?? 0);
    this.now = opts.now ?? (() => performance.now());
    this._stats = {
      mode: this._mode,
      frames: 0,
      renders: 0,
      skipped: 0,
      invalidations: 0,
      staleFrames: 0,
      heartbeats: 0,
      byReason: {},
      lastReason: null,
    };
  }

  get mode(): RenderMode {
    return this._mode;
  }

  set mode(m: RenderMode) {
    if (m === this._mode) return;
    this._mode = m;
    this._stats.mode = m;
    this.invalidate("mode");
  }

  /** Snapshot of the counters (a copy). */
  get stats(): RenderSchedulerStats {
    return { ...this._stats, byReason: { ...this._stats.byReason } };
  }

  /**
   * The view changed (or is about to). Renders the next frame and keeps
   * rendering for `keepAliveMs` and at least `keepAliveFrames` frames
   * (override per call; 0 = this frame only).
   */
  invalidate(reason = "unknown", keepAliveMs = this.keepAliveMs): void {
    this._stats.invalidations++;
    if (this.dirtyReason === null) this.dirtyReason = reason;
    const until = this.now() + Math.max(0, keepAliveMs);
    if (until > this.keepAliveUntil) this.keepAliveUntil = until;
    if (keepAliveMs > 0 && this.keepAliveFramesLeft < this.keepAliveFrames) {
      this.keepAliveFramesLeft = this.keepAliveFrames;
    }
    try {
      this.opts.onInvalidate?.();
    } catch {
      // a broken sink must never break the caller's change
    }
  }

  /**
   * Called once per animation frame, before the renderer runs. Returns
   * the reason to render this frame, or null to skip it.
   */
  frame(): string | null {
    this._stats.frames++;
    const reason = this.decide();
    if (reason === null) {
      this._stats.skipped++;
      return null;
    }
    this._stats.byReason[reason] = (this._stats.byReason[reason] ?? 0) + 1;
    this._stats.lastReason = reason;
    return reason;
  }

  /** A main render just happened: record its time and view signature. */
  rendered(): void {
    this._stats.renders++;
    this.lastRenderAt = this.now();
    this.lastSignature = this.readSignature();
  }

  private decide(): string | null {
    if (this._mode === "always") return "always";
    if (this.dirtyReason !== null) {
      const r = this.dirtyReason;
      this.dirtyReason = null;
      return r;
    }
    const t = this.now();
    if (this.keepAliveFramesLeft > 0) {
      this.keepAliveFramesLeft--;
      return "keepalive";
    }
    if (t < this.keepAliveUntil) return "keepalive";
    let cont: string | null = null;
    try {
      cont = this.opts.continuous?.() ?? null;
    } catch {
      cont = "continuous-error"; // fail safe: render
    }
    if (cont) return cont;
    const sig = this.readSignature();
    if (sig && this.lastSignature) {
      const changed = diffSignature(this.lastSignature, sig);
      if (changed.length > 0) {
        this._stats.staleFrames++;
        try {
          this.opts.onStale?.({ changed, count: this._stats.staleFrames });
        } catch {
          // reporting must not block the self-heal render
        }
        return "stale";
      }
    }
    if (this.heartbeatMs > 0 && t - this.lastRenderAt >= this.heartbeatMs) {
      this._stats.heartbeats++;
      return "heartbeat";
    }
    return null;
  }

  private readSignature(): ViewSignature | null {
    try {
      return this.opts.signature?.() ?? null;
    } catch {
      return null;
    }
  }
}

/** Names of the parts that differ between two signatures. */
export function diffSignature(a: ViewSignature, b: ViewSignature): string[] {
  const out: string[] = [];
  for (const k of Object.keys(b)) if (a[k] !== b[k]) out.push(k);
  for (const k of Object.keys(a)) if (!(k in b)) out.push(k);
  return out;
}
