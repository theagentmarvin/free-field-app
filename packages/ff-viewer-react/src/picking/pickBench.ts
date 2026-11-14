// Wave 14 — dev-only pick-latency bench.
//
// Measures the *resolution* step of the pick path (the FastModelPicker
// GPU readback OR the Raycasters sweep — whatever backend is live) and
// reports p50/p95 + sample count to the console. Gated behind the
// `?bench=1` query param so there is zero production overhead and no UI.
//
// All helpers here are pure and unit-testable: `percentile` (nearest
// rank), `computePickStats`, `isBenchEnabled`, `formatPickStats`.

import type { BackendId } from "./pickTypes";

/** Immutable summary of the accumulated bench samples. */
export interface PickStats {
  backendId: BackendId;
  samples: number;
  /** 50th percentile, milliseconds. */
  p50Ms: number;
  /** 95th percentile, milliseconds. */
  p95Ms: number;
}

/** Whether the bench is enabled for this page load. Reads `?bench=1`. */
export function isBenchEnabled(): boolean {
  try {
    const search =
      typeof window !== "undefined" && window.location
        ? window.location.search
        : "";
    return new URLSearchParams(search).get("bench") === "1";
  } catch {
    return false;
  }
}

/**
 * Nearest-rank percentile over an **ascending-sorted** array.
 * Returns `0` for empty input and clamps `q` to [0, 1] implicitly via
 * the rank formula (a `q` outside [0,1] is still clamped by the index
 * bounds below).
 *
 * @param sortedAsc - samples sorted ascending.
 * @param q          - quantile in [0, 1] (0.5 → median, 0.95 → p95).
 */
export function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil(q * sortedAsc.length) - 1;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, rank));
  return sortedAsc[idx]!;
}

/** Compute `PickStats` from raw (unsorted) millisecond samples. */
export function computePickStats(
  samples: readonly number[],
  backendId: BackendId,
): PickStats {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    backendId,
    samples: sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/** Console-format a `PickStats` summary (single line). */
export function formatPickStats(stats: PickStats): string {
  return (
    `p50=${stats.p50Ms.toFixed(3)}ms p95=${stats.p95Ms.toFixed(3)}ms ` +
    `samples=${stats.samples} backend=${stats.backendId}`
  );
}