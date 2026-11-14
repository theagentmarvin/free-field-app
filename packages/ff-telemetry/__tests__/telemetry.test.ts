import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { RingBuffer } from "../src/ringBuffer";
import {
  createTelemetry,
  deviceTags,
  installBootFlag,
  persist,
  resetPersistThrottle,
  installErrorListeners,
  startRendererSampler,
  attachWindowHooks,
  localStorageStorage,
  BOOT_FLAG_KEY,
  BUNDLE_KEY,
  type TelemetryStorage,
} from "../src/index";

/** Injected in-memory storage (jsdom never touched here). */
function memoryStorage(initial: Record<string, string> = {}): TelemetryStorage {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
    _map: m,
  } as TelemetryStorage & { _map: Map<string, string> };
}

describe("RingBuffer", () => {
  it("wraps oldest-out, preserving oldest→newest order", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.toArray()).toEqual([1, 2, 3]);
    rb.push(4);
    expect(rb.toArray()).toEqual([2, 3, 4]);
    rb.push(5);
    expect(rb.toArray()).toEqual([3, 4, 5]);
  });

  it("clear() empties the buffer", () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.clear();
    expect(rb.toArray()).toEqual([]);
  });

  it("clamps a non-positive capacity to 1 (no foot-gun)", () => {
    const rb = new RingBuffer<number>(0);
    rb.push(7);
    rb.push(8);
    expect(rb.toArray()).toEqual([8]);
  });
});

describe("createTelemetry / getBundle shape", () => {
  it("returns the full bundle with every required field", () => {
    const t = createTelemetry({ maxBreadcrumbs: 100, maxSnapshots: 60 });
    t.breadcrumb("model", "load-start", { file: "a.ifc" });
    t.snapshot("renderer", { drawCalls: 1 });
    t.noteDeviceLost();
    t.noteDeviceRestored();

    const b = t.getBundle();
    expect(typeof b.startedAt).toBe("number");
    expect(Array.isArray(b.breadcrumbs)).toBe(true);
    expect(Array.isArray(b.snapshots)).toBe(true);
    expect(b.deviceLostCount).toBe(1);
    expect(typeof b.tags).toBe("object");
    expect(b.tags).not.toBeNull();
  });

  it("keeps the latest snapshot per key + a capped ring history", () => {
    const t = createTelemetry({ maxSnapshots: 2 });
    t.snapshot("renderer", { n: 1 });
    t.snapshot("renderer", { n: 2 });
    t.snapshot("renderer", { n: 3 });
    // ring holds only the most recent 2 (wrap)
    const snaps = t.getBundle().snapshots;
    expect(snaps).toHaveLength(2);
    // and the latest value wins
    expect(snaps[snaps.length - 1].data).toEqual({ n: 3 });
  });

  it("caps breadcrumbs at maxBreadcrumbs", () => {
    const t = createTelemetry({ maxBreadcrumbs: 3 });
    for (let i = 0; i < 5; i++) t.breadcrumb("x", String(i));
    expect(t.getBundle().breadcrumbs).toHaveLength(3);
    expect(t.getBundle().breadcrumbs.map((b) => b.action)).toEqual([
      "2",
      "3",
      "4",
    ]);
  });

  it("never throws even when given garbage", () => {
    const t = createTelemetry({ maxBreadcrumbs: NaN, maxSnapshots: -5 });
    expect(() => t.breadcrumb("a", "b")).not.toThrow();
    expect(() => t.getBundle()).not.toThrow();
  });
});

describe("deviceTags", () => {
  it("collects a stable shape without throwing (jsdom, no WebGL)", () => {
    const tags = deviceTags();
    expect(tags).toBeTypeOf("object");
    for (const k of [
      "gpu",
      "webgl2",
      "deviceMemory",
      "hardwareConcurrency",
      "userAgent",
      "screen",
      "isDemoMode",
    ]) {
      expect(k in tags).toBe(true);
    }
  });
});

describe("installBootFlag", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPersistThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("raises the flag, then clears it after healthyMs (round-trip)", () => {
    const storage = memoryStorage();
    const t = createTelemetry();
    installBootFlag(t, storage, 10_000);
    expect(storage.getItem(BOOT_FLAG_KEY)).toBeTruthy();
    vi.advanceTimersByTime(10_000);
    expect(storage.getItem(BOOT_FLAG_KEY)).toBeFalsy();
  });

  it("detects a previous-killed session and surfaces the last bundle", () => {
    const lastBundle = JSON.stringify({
      startedAt: 1,
      breadcrumbs: [{ ts: 1, category: "error:Error", action: "error" }],
      snapshots: [],
      deviceLostCount: 0,
      tags: {},
    });
    const storage = memoryStorage({
      [BOOT_FLAG_KEY]: "999",
      [BUNDLE_KEY]: lastBundle,
    });
    const t = createTelemetry();
    installBootFlag(t, storage, 10_000);
    const crumbs = t.getBundle().breadcrumbs;
    expect(
      crumbs.some(
        (b) => b.category === "session" && b.action === "previous-killed",
      ),
    ).toBe(true);
    const saved = t
      .getBundle()
      .snapshots.find((s) => s.key === "previous-session");
    expect(saved).toBeTruthy();
    expect(saved?.data).toHaveProperty("startedAt", 1);
  });

  it("does not flag previous-killed on a clean start", () => {
    const storage = memoryStorage();
    const t = createTelemetry();
    installBootFlag(t, storage, 10_000);
    expect(
      t
        .getBundle()
        .breadcrumbs.some((b) => b.action === "previous-killed"),
    ).toBe(false);
  });
});

describe("persist", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPersistThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles writes to ≥ 5s and skips when unchanged", () => {
    const storage = memoryStorage();
    const t = createTelemetry();
    t.breadcrumb("a", "1");
    persist(t, storage);
    const first = storage.getItem(BUNDLE_KEY);
    expect(first).toBeTruthy();

    // immediate second write: throttled, unchanged (no new breadcrumb)
    persist(t, storage);
    expect(storage.getItem(BUNDLE_KEY)).toBe(first);

    // new breadcrumb within the throttle window → still throttled
    t.breadcrumb("a", "2");
    persist(t, storage);
    expect(storage.getItem(BUNDLE_KEY)).toBe(first);

    // past the throttle window → writes
    vi.advanceTimersByTime(5_100);
    persist(t, storage);
    expect(storage.getItem(BUNDLE_KEY)).not.toBe(first);
  });

  it("force bypasses the throttle (immediate write)", () => {
    const storage = memoryStorage();
    const t = createTelemetry();
    t.breadcrumb("a", "1");
    persist(t, storage);
    const first = storage.getItem(BUNDLE_KEY);

    t.breadcrumb("a", "2");
    persist(t, storage, true); // force
    expect(storage.getItem(BUNDLE_KEY)).not.toBe(first);
  });
});

describe("installErrorListeners", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPersistThrottle();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("breadcrumbs an error and immediately persists", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t);
    const err = new Error("boom");
    window.dispatchEvent(new ErrorEvent("error", { message: "boom", error: err }));
    const b = t.getBundle();
    expect(
      b.breadcrumbs.some((c) => c.category === "error:Error"),
    ).toBe(true);
    const persisted = window.localStorage.getItem(BUNDLE_KEY);
    expect(persisted).toBeTruthy();
    expect(persisted).toContain("boom");
    stop();
  });

  it("captures unhandledrejection with a string reason", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t);
    // jsdom has no PromiseRejectionEvent constructor — build a plain
    // Event with a `reason` property instead.
    const ev = new Event("unhandledrejection");
    Object.defineProperty(ev, "reason", { value: "network down" });
    window.dispatchEvent(ev);
    expect(
      t
        .getBundle()
        .breadcrumbs.some((c) => c.category === "error:Error"),
    ).toBe(true);
    stop();
  });

  it("ignores ResizeObserver loop and AbortError messages", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t);
    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    );
    window.dispatchEvent(
      new ErrorEvent("error", { message: "AbortError: The operation was aborted" }),
    );
    expect(t.getBundle().breadcrumbs).toHaveLength(0);
    // nothing persisted for ignored noise
    expect(window.localStorage.getItem(BUNDLE_KEY)).toBeNull();
    stop();
  });

  it("truncates message+stack to 500 chars", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t);
    const big = "x".repeat(2000);
    window.dispatchEvent(new ErrorEvent("error", { message: big }));
    const crumb = t
      .getBundle()
      .breadcrumbs.find((c) => c.category === "error:Error");
    const msg = (crumb?.data?.message as string) ?? "";
    expect(msg.length).toBeLessThanOrEqual(500);
    stop();
  });
});

describe("startRendererSampler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPersistThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("snapshots the renderer key at 1 Hz", () => {
    const t = createTelemetry();
    const read = (): { drawCalls: number; triangles: number; geometries: number; textures: number } => ({
      drawCalls: 10,
      triangles: 1000,
      geometries: 500,
      textures: 2,
    });
    const stop = startRendererSampler(t, { read, intervalMs: 1000 });
    vi.advanceTimersByTime(1000);
    const snap = t
      .getBundle()
      .snapshots.find((s) => s.key === "renderer");
    expect(snap).toBeTruthy();
    expect(snap?.data).toMatchObject({ drawCalls: 10, geometries: 500 });
    stop();
  });

  it("breadcrumbs perf:oom-risk once per crossing level", () => {
    const t = createTelemetry();
    let state = { geometries: 1000, textures: 5 };
    const read = () => ({
      drawCalls: 1,
      triangles: 1,
      geometries: state.geometries,
      textures: state.textures,
    });
    const stop = startRendererSampler(t, { read, intervalMs: 1000 });

    // cross the geometry threshold
    state = { geometries: 160_000, textures: 5 };
    vi.advanceTimersByTime(1000);
    // stay over — no new breadcrumb
    vi.advanceTimersByTime(1000);
    // cross the texture threshold
    state = { geometries: 1000, textures: 90 };
    vi.advanceTimersByTime(1000);

    const oom = t
      .getBundle()
      .breadcrumbs.filter((b) => b.category === "perf" && b.action === "oom-risk");
    expect(oom).toHaveLength(2);
    // geometry crossing carries the geometries number
    expect(oom[0].data?.geometries).toBe(160_000);
    // texture crossing carries the textures number
    expect(oom[1].data?.textures).toBe(90);
    stop();
  });

  it("reads defensively when the injected read returns missing fields", () => {
    const t = createTelemetry();
    const read = () => ({});
    const stop = startRendererSampler(t, { read });
    // immediate first tick only — nothing throws, snapshot has zeroed fields
    vi.advanceTimersByTime(0);
    const snap = t
      .getBundle()
      .snapshots.find((s) => s.key === "renderer");
    expect(snap?.data).toMatchObject({
      drawCalls: 0,
      triangles: 0,
      geometries: 0,
      textures: 0,
    });
    stop();
  });

  it("persists on persistEveryMs boundaries when opted in (12 ticks → 5s,10s)", () => {
    vi.setSystemTime(0);
    const t = createTelemetry();
    const persistCb = vi.fn();
    const stop = startRendererSampler(t, {
      read: () => ({}),
      intervalMs: 1000,
      persistEveryMs: 5000,
      persist: persistCb,
    });
    for (let i = 0; i < 12; i++) vi.advanceTimersByTime(1000);
    expect(persistCb).toHaveBeenCalledTimes(2);
    stop();
  });

  it("never persists when persistEveryMs is absent (pure default)", () => {
    vi.setSystemTime(0);
    const t = createTelemetry();
    const persistCb = vi.fn();
    const stop = startRendererSampler(t, {
      read: () => ({}),
      intervalMs: 1000,
      persist: persistCb, // callback provided, but no cadence → never fires
    });
    for (let i = 0; i < 12; i++) vi.advanceTimersByTime(1000);
    expect(persistCb).not.toHaveBeenCalled();
    stop();
  });

  it("surfaces heap watermarks into the renderer snapshot", () => {
    vi.setSystemTime(0);
    const t = createTelemetry();
    const stop = startRendererSampler(t, {
      read: () => ({ heapUsedB: 123, heapLimitB: 999 }),
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    const snap = t.getBundle().snapshots.find((s) => s.key === "renderer");
    expect(snap?.data).toMatchObject({ heapUsedB: 123, heapLimitB: 999 });
    stop();
  });
});

describe("end-to-end kill forensics (sampler persist → boot detect)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    resetPersistThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("recovers the previous session's breadcrumbs on next boot after a hard kill", () => {
    const storage = memoryStorage();

    // Session #1: raise the flag, add breadcrumb history, run the
    // sampler (persisting every 5 s), then "die" before the flag clears.
    const t1 = createTelemetry();
    installBootFlag(t1, storage, 60_000); // long healthy window
    t1.breadcrumb("model", "load-start", { file: "a.ifc" });
    const stop = startRendererSampler(t1, {
      read: () => ({ drawCalls: 42 }),
      intervalMs: 1000,
      persistEveryMs: 5000,
      persist: () => persist(t1, storage),
    });
    vi.advanceTimersByTime(6_000); // one persist at the 5 s boundary
    stop();

    // The hard kill leaves the boot flag up and the bundle on disk.
    expect(storage.getItem(BOOT_FLAG_KEY)).toBeTruthy();
    expect(storage.getItem(BUNDLE_KEY)).toBeTruthy();

    // "Reload": a brand-new telemetry instance against the SAME storage.
    const t2 = createTelemetry();
    installBootFlag(t2, storage, 60_000);
    const b2 = t2.getBundle();
    expect(
      b2.breadcrumbs.some(
        (c) => c.category === "session" && c.action === "previous-killed",
      ),
    ).toBe(true);

    const prev = b2.snapshots.find((s) => s.key === "previous-session");
    expect(prev).toBeTruthy();
    const prevCrumbs =
      (prev?.data as { breadcrumbs?: Array<{ action: string }> } | undefined)
        ?.breadcrumbs ?? [];
    expect(prevCrumbs.some((c) => c.action === "load-start")).toBe(true);
  });
});

describe("attachWindowHooks", () => {
  it("exposes get/copy/dump/export on window.__ffTelemetry", () => {
    const t = createTelemetry();
    t.breadcrumb("a", "b");
    const stop = attachWindowHooks(t);
    const api = (window as unknown as { __ffTelemetry?: { get: () => unknown; copy: () => void; dump: () => void; export: () => void } }).__ffTelemetry;
    expect(api).toBeTruthy();
    expect(typeof api?.get).toBe("function");
    expect(typeof api?.copy).toBe("function");
    expect(typeof api?.dump).toBe("function");
    expect(typeof api?.export).toBe("function");
    expect((api?.get() as { breadcrumbs: unknown[] }).breadcrumbs).toHaveLength(1);
    expect(() => api?.dump()).not.toThrow();
    stop();
  });
});

describe("localStorageStorage", () => {
  it("never throws even in a bare jsdom", () => {
    const s = localStorageStorage();
    expect(() => s.setItem("ff.x", "1")).not.toThrow();
    expect(s.getItem("ff.x")).toBe("1");
    expect(() => s.removeItem?.("ff.x")).not.toThrow();
    expect(s.getItem("ff.x")).toBeNull();
  });
});