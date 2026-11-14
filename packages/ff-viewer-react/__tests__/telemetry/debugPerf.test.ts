import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDebugPerfPayload,
  startDebugPerfTelemetry,
  type DebugPerfChainSnapshot,
  type DebugPerfSource,
} from "../../src/telemetry/debugPerf";

function chain(over: Partial<DebugPerfChainSnapshot> = {}): DebugPerfChainSnapshot {
  return {
    clicks: 3,
    applied: 2,
    superseded: 0,
    emptyClicks: 1,
    lastClickToSelectionMs: 120,
    lastClickToPointMs: 260,
    recentClickToSelectionMs: [10, 20, 30],
    lastHighlightMs: 45,
    highlightInFlight: 0,
    highlightInFlightPeak: 2,
    highlightCoalesced: 1,
    idPassRenders: 4,
    lastClickRenders: 1,
    ...over,
  };
}

function makeSource(initial: DebugPerfChainSnapshot | null): {
  src: DebugPerfSource;
  set: (c: DebugPerfChainSnapshot | null) => void;
} {
  let cur = initial;
  const src: DebugPerfSource = {
    getChainStats: () => cur,
    getBenchSamples: () => [11],
    getBackend: () => "fast",
    getBatchedReaderActive: () => true,
  };
  return { src, set: (c) => { cur = c; } };
}

type Payload = {
  chain: Record<string, number>;
  bench: Record<string, number>;
  newClicks?: number;
  debugStats?: unknown;
  batchedReaderActive?: boolean;
};

describe("buildDebugPerfPayload", () => {
  it("computes click-to-selection percentiles over the recent window", () => {
    const p = buildDebugPerfPayload(chain(), [5, 7], "fast", true) as Payload;
    expect(p.chain.clickToSelectionP50Ms).toBe(20);
    expect(p.chain.clickToSelectionP95Ms).toBe(30);
    expect(p.chain.clickToSelectionSamples).toBe(3);
    expect(p.chain.lastClickToSelectionMs).toBe(120);
    expect(p.chain.lastClickToPointMs).toBe(260);
    expect(p.chain.idPassRendersTotal).toBe(4);
    expect(p.chain.lastClickRenders).toBe(1);
    expect(p.bench.p50Ms).toBe(5);
    expect(p.bench.p95Ms).toBe(7);
    expect(p.bench.samples).toBe(2);
    expect(p.batchedReaderActive).toBe(true);
  });

  it("survives empty windows and passes debugStats through", () => {
    const stats = { heapMB: 300 };
    const p = buildDebugPerfPayload(
      chain({ recentClickToSelectionMs: [] }),
      [],
      "raycaster",
      false,
      stats,
    ) as Payload;
    expect(p.chain.clickToSelectionP50Ms).toBe(0);
    expect(p.bench.samples).toBe(0);
    expect(p.debugStats).toEqual(stats);
    expect(p.batchedReaderActive).toBe(false);
  });
});

describe("startDebugPerfTelemetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ships nothing while idle", () => {
    const { src } = makeSource(chain({ clicks: 0 }));
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    vi.advanceTimersByTime(5000);
    expect(ship).not.toHaveBeenCalled();
    dispose();
    expect(ship).not.toHaveBeenCalled();
  });

  it("ships once per active window with newClicks", () => {
    const { src, set } = makeSource(chain({ clicks: 4 }));
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(1);
    expect((ship.mock.calls[0][0] as Payload).newClicks).toBe(4);
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(1);
    set(chain({ clicks: 7 }));
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(2);
    expect((ship.mock.calls[1][0] as Payload).newClicks).toBe(3);
    dispose();
  });

  it("flushes the last window on dispose and stops the interval", () => {
    const { src, set } = makeSource(chain({ clicks: 0 }));
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    set(chain({ clicks: 2 }));
    dispose();
    expect(ship).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(ship).toHaveBeenCalledTimes(1);
  });

  it("never throws into the app when the sink throws", () => {
    const { src } = makeSource(chain({ clicks: 1 }));
    const ship = vi.fn(() => {
      throw new Error("sentry down");
    });
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow();
    // window committed before ship → the same burst never re-ships
    expect(ship).toHaveBeenCalledTimes(1);
    dispose();
    expect(ship).toHaveBeenCalledTimes(1);
  });

  it("tolerates a null chain snapshot", () => {
    const { src, set } = makeSource(null);
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    vi.advanceTimersByTime(3000);
    expect(ship).not.toHaveBeenCalled();
    set(chain({ clicks: 1 }));
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("startDebugPerfTelemetry outcome-delta shipping (wave 27b)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ships a stall outcome even when no new clicks landed", () => {
    const { src, set } = makeSource(chain({ clicks: 2 }));
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(1);
    // Same clicks, but the stall guard fired afterwards → must ship.
    set(
      chain({
        clicks: 2,
        pickTimeouts: 1,
        lastClickToSelectionMs: null,
      }),
    );
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(2);
    const p = ship.mock.calls[1][0] as Payload & {
      chain: { pickTimeouts?: number };
    };
    expect(p.newClicks).toBe(0);
    expect(p.chain.pickTimeouts).toBe(1);
    dispose();
  });

  it("stays silent when neither clicks nor outcomes move", () => {
    const { src } = makeSource(chain({ clicks: 1, pickTimeouts: 1 }));
    const ship = vi.fn();
    const dispose = startDebugPerfTelemetry(src, ship, 1000);
    vi.advanceTimersByTime(1000);
    expect(ship).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000);
    expect(ship).toHaveBeenCalledTimes(1);
    dispose();
  });
});
