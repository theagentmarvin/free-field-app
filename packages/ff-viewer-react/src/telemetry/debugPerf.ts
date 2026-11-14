// Wave 26 — debug-gated chain-performance telemetry emitter.
//
// The click→highlight chain counters (wave 22) and the pick bench
// samples (wave 14) existed but were console/window-only. When the
// opt-in debug surface arms (DEV build AND `?ffdebug=1` — see
// IfcViewer arming block), this emitter turns every interval window
// WITH clicks into exactly one Sentry Channel-A `info` event named
// `debug-perf-chain` carrying: chain latencies, bench percentiles,
// the render-count tell for the batched fast path, the full
// `stats()` snapshot, and whatever Channel A auto-attaches to every
// event (the renderer report: draw calls, geometries, textures).
//
// Policy:
// - Idle windows (no new clicks) ship NOTHING — no quota burn.
// - Production path: never armed, zero overhead.
// - Survivability law: every tick is try/catch — telemetry can never
//   throw into the viewer, and a throwing sink still leaves the next
//   tick scheduled.

import { percentile } from "../picking/pickBench";

/** Structural mirror of `chainStatsRef.current` in IfcViewer. */
export interface DebugPerfChainSnapshot {
  clicks: number;
  applied: number;
  superseded: number;
  emptyClicks: number;
  lastClickToSelectionMs: number | null;
  lastClickToPointMs: number | null;
  recentClickToSelectionMs: number[];
  lastHighlightMs: number | null;
  highlightInFlight: number;
  highlightInFlightPeak: number;
  highlightCoalesced: number;
  idPassRenders: number;
  lastClickRenders: number;
  /** Wave 27: degrade + stall counters (optional: refs pre-27). */
  degrades?: number;
  lastDegradeReason?: string | null;
  pickTimeouts?: number;
  /**
   * Wave 28: the cost breakdown + UNKNOWN outcomes. Optional because
   * the structural mirror must stay valid against a pre-28 ref.
   */
  inconclusiveClicks?: number;
  pickTranslateTimeouts?: number;
  phase2Timeouts?: number;
  lastPickRpcs?: number | null;
  lastPickReadbacks?: number | null;
  lastPickCacheHits?: number | null;
  lastPickBoxRead?: boolean | null;
  lastPickScissor?: boolean | null;
}

export interface DebugPerfSource {
  getChainStats: () => DebugPerfChainSnapshot | null;
  getBenchSamples: () => number[];
  getBackend: () => string;
  /** batched id-pass reader present → the fast path is wired. */
  getBatchedReaderActive: () => boolean;
  /** the window.__ffDebug stats() snapshot — heap, selections, lods. */
  getDebugStats?: () => unknown;
}

/** Event title shared with the Sentry query side. */
export const DEBUG_PERF_EVENT = "debug-perf-chain";

function nearestRankP(sortedAsc: readonly number[], q: number): number {
  return sortedAsc.length === 0 ? 0 : percentile(sortedAsc as number[], q);
}

/** Pure payload builder — unit-testable, no timers, no Sentry. */
export function buildDebugPerfPayload(
  chain: DebugPerfChainSnapshot,
  benchSamples: readonly number[],
  backend: string,
  batchedReaderActive: boolean,
  debugStats?: unknown,
  newClicks?: number,
): Record<string, unknown> {
  const recent = [...chain.recentClickToSelectionMs].sort(
    (a, b) => a - b,
  );
  const bench = [...benchSamples].sort((a, b) => a - b);
  return {
    payloadVersion: 1,
    backend,
    batchedReaderActive,
    ...(typeof newClicks === "number" ? { newClicks } : {}),
    chain: {
      clicks: chain.clicks,
      applied: chain.applied,
      superseded: chain.superseded,
      emptyClicks: chain.emptyClicks,
      lastClickToSelectionMs: chain.lastClickToSelectionMs,
      lastClickToPointMs: chain.lastClickToPointMs,
      clickToSelectionP50Ms: nearestRankP(recent, 0.5),
      clickToSelectionP95Ms: nearestRankP(recent, 0.95),
      clickToSelectionSamples: recent.length,
      lastHighlightMs: chain.lastHighlightMs,
      highlightInFlight: chain.highlightInFlight,
      highlightInFlightPeak: chain.highlightInFlightPeak,
      highlightCoalesced: chain.highlightCoalesced,
      idPassRendersTotal: chain.idPassRenders,
      lastClickRenders: chain.lastClickRenders,
      degrades: chain.degrades ?? 0,
      lastDegradeReason: chain.lastDegradeReason ?? null,
      pickTimeouts: chain.pickTimeouts ?? 0,
      // Wave 28: what the last click actually paid. `lastPickRpcs: 33`
      // in a Sentry event means the per-probe fan-out is back; `0` with
      // `lastPickCacheHits: 1` means the repeat-click cache served it.
      inconclusiveClicks: chain.inconclusiveClicks ?? 0,
      pickTranslateTimeouts: chain.pickTranslateTimeouts ?? 0,
      phase2Timeouts: chain.phase2Timeouts ?? 0,
      lastPickRpcs: chain.lastPickRpcs ?? null,
      lastPickReadbacks: chain.lastPickReadbacks ?? null,
      lastPickCacheHits: chain.lastPickCacheHits ?? null,
      lastPickBoxRead: chain.lastPickBoxRead ?? null,
      lastPickScissor: chain.lastPickScissor ?? null,
    },
    bench: {
      samples: bench.length,
      p50Ms: nearestRankP(bench, 0.5),
      p95Ms: nearestRankP(bench, 0.95),
    },
    debugStats: debugStats ?? null,
  };
}

/**
 * Start the emitter. Returns a dispose function (also flushes the
 * final in-flight window so a teardown after a click burst still
 * ships the data).
 */
export function startDebugPerfTelemetry(
  source: DebugPerfSource,
  ship: (payload: Record<string, unknown>) => void,
  intervalMs = 5000,
): () => void {
  let lastShippedClicks = 0;
  // Wave 27b: wave-27 counters are OUTCOME signals. A stall (pickTimeouts)
  // or a degrade can land AFTER the last click of a burst — shipping only
  // on new clicks hid exactly the evidence that matters (observed on the
  // boss's 19:29 /models session: mid-flight snapshot, outcome never
  // shipped). Ship when clicks advance OR the outcome counters advance.
  const outcome = (chain: DebugPerfChainSnapshot): number =>
    (chain.pickTimeouts ?? 0) + (chain.degrades ?? 0);
  let lastShippedOutcome = 0;
  const tick = (): void => {
    try {
      const chain = source.getChainStats();
      if (!chain) return;
      const state = outcome(chain);
      if (chain.clicks <= lastShippedClicks && state <= lastShippedOutcome) {
        return;
      }
      const newClicks = Math.max(0, chain.clicks - lastShippedClicks);
      const payload = buildDebugPerfPayload(
        chain,
        source.getBenchSamples(),
        source.getBackend(),
        source.getBatchedReaderActive(),
        source.getDebugStats?.(),
        newClicks,
      );
      // Commit the counters BEFORE ship so a throwing sink cannot make
      // the same window re-ship every tick.
      lastShippedClicks = chain.clicks;
      lastShippedOutcome = state;
      ship(payload);
    } catch {
      // Survivability law: never reach app code.
    }
  };
  const id = setInterval(tick, intervalMs);
  return () => {
    clearInterval(id);
    tick();
  };
}
