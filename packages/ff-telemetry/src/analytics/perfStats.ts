// analytics/perfStats.ts — session performance accumulator + timeline
// for the Channel C (Firebase Analytics) rollup.
//
// Two pure, firebase-free building blocks live here:
//
// 1. `createPerfStatsAccumulator()` — a *histogram-bucketed* accumulator
//    fed from the frame timer's rolling percentiles (spec §5.6:
//    `frame_ms_p50/p95/p99` — "histogram-bucketed via perfStats.ts").
//    Three independent histograms are kept (one per percentile
//    series) so a single pass over the session yields the session's
//    p50 / p95 / p99 without ever materialising the raw frame deltas.
//
// 2. `createSessionTimeline()` — the load timeline used for
//    `ifc_to_first_frame_ms` and `fragment_decode_ms` (spec §5.6).
//    `ifc_to_first_frame_ms` = load-start breadcrumb ts → the first
//    frame tick observed after load-complete.
//    `fragment_decode_ms` = the web-ifc worker span when it is
//    measurable, otherwise the load-complete − load-start proxy.
//
// Survivability law: pure data structures, no DOM, no firebase, no
// `three`. Nothing here can throw; the hot path (frame tick) does not
// allocate (pre-allocated typed ring buffer).

/** One rolling-percentile reading (the frame timer's shape). */
export interface FramePercentiles {
  /** 50th-percentile frame delta, ms. */
  p50: number;
  /** 95th-percentile frame delta, ms. */
  p95: number;
  /** 99th-percentile frame delta, ms. */
  p99: number;
}

/** A frame reading plus optional extras the accumulator tracks. */
export interface PerfSample extends FramePercentiles {
  /** Latest EMA of frame deltas, ms. */
  emaMs?: number;
  /** Latest max frame delta, ms. */
  maxMs?: number;
}

/** Structural shape of `frameTimer`'s `FrameStats` (kept local so this
 *  module stays dependency-free). */
export interface FrameStatsLike extends FramePercentiles {
  frameEmaMs?: number;
  frameMaxMs?: number;
  sampleCount?: number;
}

/** A session-level read of the accumulator. */
export interface PerfStatsSnapshot {
  /** Session frame p50, ms. */
  frameP50: number;
  /** Session frame p95, ms. */
  frameP95: number;
  /** Session frame p99, ms. */
  frameP99: number;
  /** Latest EMA seen while accumulating, ms. */
  frameEmaMs: number;
  /** Largest frame delta seen while accumulating, ms. */
  frameMaxMs: number;
  /** Number of samples folded into the histograms. */
  sampleCount: number;
  /** Frame-time histogram (the p50 series), bucket label → count. */
  buckets: Record<string, number>;
  /** Bucket upper bounds in ms (the open bucket is the last one). */
  bucketEdges: number[];
  /** Per-series histograms (p50 / p95 / p99). */
  histograms: {
    p50: Record<string, number>;
    p95: Record<string, number>;
    p99: Record<string, number>;
  };
}

/** The accumulator handle. */
export interface PerfStatsAccumulator {
  /** Fold one reading into the histograms. */
  add(sample: PerfSample): void;
  /** Fold a `frameTimer.getFrameStats()`-shaped reading. */
  addFrameStats(stats: FrameStatsLike): void;
  /** Read the session-level summary. Never throws. */
  snapshot(): PerfStatsSnapshot;
  /** Drop every sample. */
  reset(): void;
}

/** Default bucket upper bounds (ms). The last bucket is open-ended. */
export const DEFAULT_BUCKET_EDGES: readonly number[] = [8, 16, 33, 50, 100];

/** How many exact readings are retained per series (≈ 8.5 min at 1 Hz). */
const RING_CAPACITY = 512;

/**
 * Bucket labels for the given edges, e.g. `["le_8", "8_16", …,
 * "gt_100"]`. The open (last) bucket is labelled `gt_<edge>`.
 */
export function bucketLabels(edges: readonly number[]): string[] {
  const labels: string[] = [];
  let lower = 0;
  for (const edge of edges) {
    labels.push(`${lower}_${edge}`);
    lower = edge;
  }
  labels.push(`gt_${lower}`);
  return labels;
}

/** Index of the bucket a value falls into (clamped to the open bucket). */
export function bucketIndexFor(
  value: number,
  edges: readonly number[],
): number {
  if (!Number.isFinite(value)) return 0;
  for (let i = 0; i < edges.length; i++) {
    if (value <= edges[i]!) return i;
  }
  return edges.length;
}

/**
 * Percentile from a bucketed histogram.
 *
 * The bucket population is assumed uniformly distributed inside the
 * bucket, so the value is linearly interpolated between the bucket
 * bounds. The open (last) bucket uses a nominal upper bound of
 * `1.5 ×` its lower bound. Deterministic and byte-stable.
 */
export function percentileFromHistogram(
  counts: readonly number[],
  edges: readonly number[],
  q: number,
): number {
  const total = counts.reduce((sum, c) => sum + (Number.isFinite(c) ? c : 0), 0);
  if (total <= 0) return 0;
  const quantile = Math.min(1, Math.max(0, q));
  const target = quantile * total;

  let cumulative = 0;
  let lower = 0;
  for (let i = 0; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    const edge = edges[i];
    const upper =
      edge === undefined
        ? lower * 1.5 // open-ended bucket → nominal upper bound
        : edge;
    if (count > 0 && target <= cumulative + count) {
      const frac = Math.min(1, Math.max(0, (target - cumulative) / count));
      return lower + (upper - lower) * frac;
    }
    cumulative += count;
    if (edge !== undefined) lower = edge;
  }
  return lower;
}

function emptyCounts(size: number): number[] {
  return new Array<number>(size).fill(0);
}

/** Nearest-rank percentile over an ascending array (same rule as the
 *  frame timer's percentiles). */
function nearestRankPercentile(sorted: readonly number[], p: number): number {
  const k = sorted.length;
  if (k === 0) return 0;
  const idx = Math.max(0, Math.min(k - 1, Math.ceil(p * k) - 1));
  return sorted[idx] ?? 0;
}

/** A bounded, allocation-free ring of the exact readings of one
 *  percentile series. */
class ReadingRing {
  private readonly values = new Float64Array(RING_CAPACITY);
  private count = 0;
  private write = 0;
  private readonly scratch: number[] = [];

  push(value: number): void {
    this.values[this.write] = value;
    this.write = (this.write + 1) % RING_CAPACITY;
    if (this.count < RING_CAPACITY) this.count += 1;
  }

  get size(): number {
    return this.count;
  }

  /** Nearest-rank percentile of the retained readings. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    this.scratch.length = 0;
    for (let i = 0; i < this.count; i++) {
      this.scratch.push(this.values[i]!);
    }
    this.scratch.sort((a, b) => a - b);
    return nearestRankPercentile(this.scratch, p);
  }

  clear(): void {
    this.count = 0;
    this.write = 0;
    this.scratch.length = 0;
  }
}

function countsToLabels(
  counts: readonly number[],
  labels: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < labels.length; i++) {
    out[labels[i]!] = counts[i] ?? 0;
  }
  return out;
}

/**
 * Create a histogram-bucketed frame-time accumulator.
 *
 * Feed it the frame timer's rolling percentiles (1 Hz is plenty); the
 * snapshot reports the session-level p50 / p95 / p99 plus the
 * bucketed distribution.
 */
export function createPerfStatsAccumulator(
  options: { bucketEdges?: readonly number[] } = {},
): PerfStatsAccumulator {
  const edges =
    options.bucketEdges && options.bucketEdges.length > 0
      ? [...options.bucketEdges].sort((a, b) => a - b)
      : [...DEFAULT_BUCKET_EDGES];
  const labels = bucketLabels(edges);

  const hP50 = emptyCounts(labels.length);
  const hP95 = emptyCounts(labels.length);
  const hP99 = emptyCounts(labels.length);

  // The exact readings are kept in bounded rings next to the
  // histograms: the histogram is the *bucketed distribution* we ship
  // (spec §5.6 "histogram-bucketed"), while the reported percentiles
  // are read from the exact values — a histogram alone cannot resolve
  // a value inside a bucket (it would be off by up to half a bucket
  // width, e.g. 16 ms reported as 12 ms).
  const ringP50 = new ReadingRing();
  const ringP95 = new ReadingRing();
  const ringP99 = new ReadingRing();

  let sampleCount = 0;
  let emaMs = 0;
  let maxMs = 0;

  const bump = (hist: number[], value: number): void => {
    const idx = bucketIndexFor(value, edges);
    hist[idx] = (hist[idx] ?? 0) + 1;
  };

  const accumulator: PerfStatsAccumulator = {
    add(sample) {
      const p50 = Number(sample?.p50);
      const p95 = Number(sample?.p95);
      const p99 = Number(sample?.p99);
      if (Number.isFinite(p50)) {
        bump(hP50, p50);
        ringP50.push(p50);
      }
      if (Number.isFinite(p95)) {
        bump(hP95, p95);
        ringP95.push(p95);
      }
      if (Number.isFinite(p99)) {
        bump(hP99, p99);
        ringP99.push(p99);
      }
      sampleCount += 1;
      if (typeof sample?.emaMs === "number" && Number.isFinite(sample.emaMs)) {
        emaMs = sample.emaMs;
      }
      if (typeof sample?.maxMs === "number" && Number.isFinite(sample.maxMs)) {
        if (sample.maxMs > maxMs) maxMs = sample.maxMs;
      }
    },

    addFrameStats(stats) {
      accumulator.add({
        p50: Number(stats?.p50 ?? 0),
        p95: Number(stats?.p95 ?? 0),
        p99: Number(stats?.p99 ?? 0),
        emaMs:
          typeof stats?.frameEmaMs === "number" ? stats.frameEmaMs : undefined,
        maxMs:
          typeof stats?.frameMaxMs === "number" ? stats.frameMaxMs : undefined,
      });
    },

    snapshot() {
      return {
        frameP50:
          ringP50.size > 0
            ? ringP50.percentile(0.5)
            : percentileFromHistogram(hP50, edges, 0.5),
        frameP95:
          ringP95.size > 0
            ? ringP95.percentile(0.95)
            : percentileFromHistogram(hP95, edges, 0.95),
        frameP99:
          ringP99.size > 0
            ? ringP99.percentile(0.99)
            : percentileFromHistogram(hP99, edges, 0.99),
        frameEmaMs: emaMs,
        frameMaxMs: maxMs,
        sampleCount,
        buckets: countsToLabels(hP50, labels),
        bucketEdges: [...edges],
        histograms: {
          p50: countsToLabels(hP50, labels),
          p95: countsToLabels(hP95, labels),
          p99: countsToLabels(hP99, labels),
        },
      };
    },

    reset() {
      for (let i = 0; i < hP50.length; i++) {
        hP50[i] = 0;
        hP95[i] = 0;
        hP99[i] = 0;
      }
      ringP50.clear();
      ringP95.clear();
      ringP99.clear();
      sampleCount = 0;
      emaMs = 0;
      maxMs = 0;
    },
  };

  return accumulator;
}

/** The load timeline behind `ifc_to_first_frame_ms` / `fragment_decode_ms`. */
export interface SessionTimeline {
  /** Note the model load-start (breadcrumb ts, wall clock). */
  noteLoadStart(ts?: number): void;
  /** Note the model load-complete (breadcrumb ts, wall clock). */
  noteLoadComplete(ts?: number): void;
  /** Note a rendered frame (wall clock ts). */
  noteFrameTick(ts?: number): void;
  /** Record a measured web-ifc worker span (ms) when available. */
  noteWorkerSpanMs(ms: number): void;
  /** load-start → first frame after load-complete, ms (null when unknown). */
  ifcToFirstFrameMs(): number | null;
  /** worker span when measurable, else the §5.6 load-complete − load-start proxy. */
  fragmentDecodeMs(): number | null;
  /** The matched load-start ts (null when unknown). */
  loadStartTs(): number | null;
  /** The load-complete ts (null when unknown). */
  loadCompleteTs(): number | null;
  /** The first frame tick after load-complete (null when unknown). */
  firstFrameTs(): number | null;
  /** Drop every recorded mark. */
  reset(): void;
}

/** Capacity of the frame-tick ring (≈ 8.5 s at 60 Hz). */
const TICK_RING_CAPACITY = 512;

/**
 * Create the session timeline.
 *
 * The frame-tick ring lets us answer "which was the FIRST frame after
 * load-complete?" even when the load-complete mark is discovered late
 * (the breadcrumb is read from the telemetry ring on a poll, the
 * frame ticks are observed continuously).
 */
export function createSessionTimeline(): SessionTimeline {
  const ticks = new Float64Array(TICK_RING_CAPACITY);
  let tickCount = 0;
  let tickWrite = 0;

  let currentLoadStart: number | null = null;
  let matchedLoadStart: number | null = null;
  let loadComplete: number | null = null;
  let firstFrame: number | null = null;
  let workerSpanMs: number | null = null;

  const pushTick = (ts: number): void => {
    ticks[tickWrite] = ts;
    tickWrite = (tickWrite + 1) % TICK_RING_CAPACITY;
    if (tickCount < TICK_RING_CAPACITY) tickCount += 1;
  };

  /** First recorded tick strictly after `ts` (null when none). */
  const findFirstTickAfter = (ts: number): number | null => {
    for (let i = 0; i < tickCount; i++) {
      const v = ticks[i]!;
      if (v > ts) return v;
    }
    return null;
  };

  const timeline: SessionTimeline = {
    noteLoadStart(ts) {
      const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
      // Monotonic guard: re-reading the same breadcrumb is a no-op.
      if (currentLoadStart !== null && t <= currentLoadStart) return;
      currentLoadStart = t;
    },

    noteLoadComplete(ts) {
      const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
      if (loadComplete !== null && t <= loadComplete) return;
      loadComplete = t;
      matchedLoadStart = currentLoadStart;
      currentLoadStart = null;
      // The first frame may already have happened between the real
      // load-complete and the moment we learned about it → look back.
      const found = findFirstTickAfter(t);
      if (found !== null) firstFrame = found;
    },

    noteFrameTick(ts) {
      const t = typeof ts === "number" && Number.isFinite(ts) ? ts : Date.now();
      pushTick(t);
      if (loadComplete !== null && firstFrame === null && t > loadComplete) {
        firstFrame = t;
      }
    },

    noteWorkerSpanMs(ms) {
      if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) {
        workerSpanMs = ms;
      }
    },

    ifcToFirstFrameMs() {
      if (firstFrame === null || matchedLoadStart === null) return null;
      const delta = firstFrame - matchedLoadStart;
      return delta >= 0 ? delta : null;
    },

    fragmentDecodeMs() {
      // Measured web-ifc worker span wins when it exists…
      if (workerSpanMs !== null) return workerSpanMs;
      // …otherwise the §5.6 proxy: load-complete − load-start.
      if (loadComplete === null || matchedLoadStart === null) return null;
      const delta = loadComplete - matchedLoadStart;
      return delta >= 0 ? delta : null;
    },

    loadStartTs() {
      return matchedLoadStart;
    },

    loadCompleteTs() {
      return loadComplete;
    },

    firstFrameTs() {
      return firstFrame;
    },

    reset() {
      tickCount = 0;
      tickWrite = 0;
      currentLoadStart = null;
      matchedLoadStart = null;
      loadComplete = null;
      firstFrame = null;
      workerSpanMs = null;
    },
  };

  return timeline;
}
