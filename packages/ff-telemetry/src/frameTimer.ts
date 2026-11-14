// frameTimer.ts — the rAF frame-time ticker (RendererDiagnostics frame
// stats analog). Runs one requestAnimationFrame loop; on each tick it
// computes the instantaneous frame delta and folds it into an EMA
// (α = 0.1) plus a fixed-capacity *typed* rolling window of recent
// deltas for p50 / p95 / p99 + frameMax reads.
//
// The rAF path performs NO per-frame allocations: the rolling window is
// a pre-allocated Float64Array reused across frames, and the only
// per-frame work is O(1) arithmetic + one typed-array write. Percentile
// math (which needs a sort) is deferred to `getFrameStats()` — the
// sampler reads that once per second, never per frame, so the 60 Hz hot
// path stays allocation-free (spec §9 risk 1).
//
// Survivability law: rAF + clock are injectable so this stays DOM-free
// at module load and jsdom-safe; every body is safe()-wrapped; never
// imports `three` (structural/primitive types only).

import { safe } from "./safe";

/** A point-in-time read of the shared frame-time statistics. */
export interface FrameStats {
  /** Exponential moving average of frame deltas, ms (α = 0.1). */
  frameEmaMs: number;
  /** Maximum frame delta observed in the rolling window, ms. */
  frameMaxMs: number;
  /** Number of deltas currently in the rolling window. */
  sampleCount: number;
  /** 50th-percentile frame delta, ms (nearest-rank). */
  p50: number;
  /** 95th-percentile frame delta, ms (nearest-rank). */
  p95: number;
  /** 99th-percentile frame delta, ms (nearest-rank). */
  p99: number;
}

/** Injectable dependencies so jsdom tests can drive frames
 *  deterministically (fake-RAF harness) without touching a browser. */
export interface FrameTimerOptions {
  /** Injected requestAnimationFrame (fake-RAF in tests). */
  requestAnimationFrame?: (cb: FrameRequestCallback) => number;
  /** Injected cancelAnimationFrame. */
  cancelAnimationFrame?: (id: number) => void;
  /** Injected clock (returns ms). Defaults to `performance.now` then
   *  `Date.now` when unavailable. */
  now?: () => number;
  /** EMA smoothing factor (0 < α < 1). Default 0.1. */
  alpha?: number;
  /** Rolling window capacity (≥ 2). Default 120 (~2 s at 60 Hz). */
  maxSamples?: number;
}

const DEFAULT_ALPHA = 0.1;
const DEFAULT_MAX_SAMPLES = 120;

function emptyStats(): FrameStats {
  return {
    frameEmaMs: 0,
    frameMaxMs: 0,
    sampleCount: 0,
    p50: 0,
    p95: 0,
    p99: 0,
  };
}

/** Reused mutable accumulator — the `latest` read point. Only primitives
 *  plus a Float64Array reference; mutated (never re-allocated) in the
 *  hot path. */
interface Accumulator {
  frameEmaMs: number;
  filled: number;
  samples: Float64Array;
}

// Module-level "latest" stats — the shared read point for the sampler.
// There is conceptually one rAF loop per World, so a single latest
// value (overwritten by `startFrameTimer`) is correct.
let latest: Accumulator = {
  frameEmaMs: 0,
  filled: 0,
  samples: new Float64Array(0),
};

function defaultNow(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

/** Nearest-rank percentile on a sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  const k = sorted.length;
  if (k === 0) return 0;
  const idx = Math.max(0, Math.min(k - 1, Math.ceil(p * k) - 1));
  return sorted[idx] ?? 0;
}

/** Read the latest frame stats (a fresh copy; percentiles are computed
 *  here, i.e. on-demand — never per frame). Never throws. */
export function getFrameStats(): FrameStats {
  return (
    safe(() => {
      const acc = latest;
      const filled = acc.filled;
      if (filled === 0) {
        return { ...emptyStats(), frameEmaMs: acc.frameEmaMs };
      }
      // Collect the valid window values. Order is irrelevant for
      // max/percentile, so a straight scan of the valid prefix/full
      // window is sufficient (the ring overwrites in order until full).
      const dense: number[] = [];
      let frameMaxMs = 0;
      for (let i = 0; i < filled; i++) {
        const v = acc.samples[i] ?? 0;
        dense.push(v);
        if (v > frameMaxMs) frameMaxMs = v;
      }
      dense.sort((a, b) => a - b);
      return {
        frameEmaMs: acc.frameEmaMs,
        frameMaxMs,
        sampleCount: filled,
        p50: percentile(dense, 0.5),
        p95: percentile(dense, 0.95),
        p99: percentile(dense, 0.99),
      };
    }, "getFrameStats failed") ?? emptyStats()
  );
}

/**
 * Start the frame timer. Returns a `stop()` function.
 *
 * On the first tick the clock is recorded as the baseline (no sample);
 * every subsequent tick folds `delta = now - lastNow` into the EMA and
 * appends it to the rolling window. `cb` (optional) is a zero-allocation
 * per-frame notifier — callers that need numbers should call
 * `getFrameStats()` (the sampler does this at 1 Hz).
 */
export function startFrameTimer(
  cb?: () => void,
  options: FrameTimerOptions = {},
): () => void {
  return (
    safe(() => {
      const now = options.now ?? defaultNow;
      const raf =
        options.requestAnimationFrame ??
        ((fn: FrameRequestCallback): number => {
          // No rAF available (bare node / jsdom without the visual
          // flag): schedule nothing — the timer idles harmlessly.
          if (typeof requestAnimationFrame === "function") {
            return requestAnimationFrame(fn);
          }
          return 0;
        });
      const cancel =
        options.cancelAnimationFrame ??
        ((id: number): void => {
          if (typeof cancelAnimationFrame === "function") {
            cancelAnimationFrame(id);
          }
        });

      const alpha =
        typeof options.alpha === "number" &&
        Number.isFinite(options.alpha) &&
        options.alpha > 0 &&
        options.alpha < 1
          ? options.alpha
          : DEFAULT_ALPHA;
      const maxSamples =
        typeof options.maxSamples === "number" &&
        Number.isFinite(options.maxSamples) &&
        options.maxSamples >= 2
          ? Math.floor(options.maxSamples)
          : DEFAULT_MAX_SAMPLES;

      // Pre-allocated accumulators (NO per-frame allocation).
      const samples = new Float64Array(maxSamples);
      let writeIndex = 0;
      let filled = 0;
      let emaMs = 0;
      let lastNow: number | null = null;
      let stopped = false;
      let rafId = 0;

      // Reseat the shared read point to THIS timer's window so a fresh
      // start never leaks a stale previous timer's samples into reads.
      latest = { frameEmaMs: 0, filled: 0, samples };

      const tick = (): void => {
        if (stopped) return;
        const t = now();
        if (lastNow === null) {
          lastNow = t;
        } else {
          const delta = Math.max(0, t - lastNow);
          lastNow = t;
          if (filled === 0) {
            emaMs = delta;
          } else {
            emaMs = alpha * delta + (1 - alpha) * emaMs;
          }
          samples[writeIndex] = delta;
          writeIndex = (writeIndex + 1) % maxSamples;
          if (filled < maxSamples) filled += 1;

          // Mutate (never re-allocate) the shared accumulator.
          latest.frameEmaMs = emaMs;
          latest.filled = filled;
        }
        if (cb) safe(cb, "frameTimer cb failed");
        rafId = raf(tick);
      };

      rafId = raf(tick);

      return () => {
        stopped = true;
        safe(() => {
          if (rafId !== 0) cancel(rafId);
        }, "frameTimer cancel failed");
      };
    }, "startFrameTimer failed") ?? (() => {}) // eslint-disable-line @typescript-eslint/no-empty-function
  );
}