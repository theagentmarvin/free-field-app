import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  // hash
  hashUid,
  sha256Hex,
  sha256HexAsync,
  hasWebCryptoSubtle,
  buildUidHashInput,
  dailySaltFor,
  utf8Bytes,
  UID_HASH_LENGTH,
  // perf stats
  createPerfStatsAccumulator,
  createSessionTimeline,
  percentileFromHistogram,
  bucketIndexFor,
  bucketLabels,
  DEFAULT_BUCKET_EDGES,
  // analytics
  initAnalytics,
  setAnalyticsOptIn,
  isAnalyticsOptIn,
  getAnalyticsSamplingPct,
  getAnalyticsUidHash,
  buildSessionRollup,
  buildRollupEventParams,
  logSessionRollup,
  recordFrameStats,
  recordFrameTick,
  noteModelLoadStart,
  noteModelLoadComplete,
  noteFragmentDecodeSpan,
  resetAnalyticsForTests,
  stopAnalytics,
  setErrorReporter,
  getErrorReporter,
  ROLLUP_EVENT_NAME,
  DEFAULT_SAMPLING_KEY,
  type AnalyticsDeps,
  type AnalyticsModuleLike,
  type RemoteConfigModuleLike,
  type SessionRollupSummary,
} from "../src/index";

// --- fakes -----------------------------------------------------------

interface FakeAnalytics {
  module: AnalyticsModuleLike;
  logEvent: ReturnType<typeof vi.fn>;
  getAnalytics: ReturnType<typeof vi.fn>;
}

function fakeAnalytics(supported = true): FakeAnalytics {
  const logEvent = vi.fn();
  const getAnalytics = vi.fn(() => ({ fake: "analytics-instance" }));
  return {
    module: {
      getAnalytics,
      logEvent,
      isSupported: vi.fn(async () => supported),
    },
    logEvent,
    getAnalytics,
  };
}

interface FakeRemoteConfig {
  module: RemoteConfigModuleLike;
  getValue: ReturnType<typeof vi.fn>;
  fetchAndActivate: ReturnType<typeof vi.fn>;
}

function fakeRemoteConfig(
  pct: number | string,
  options: { failFetch?: boolean } = {},
): FakeRemoteConfig {
  const fetchAndActivate = vi.fn(async () => {
    if (options.failFetch) throw new Error("RC fetch failed");
    return true;
  });
  const getValue = vi.fn((_rc: unknown, _key: string) => ({
    asNumber: () => (typeof pct === "number" ? pct : Number(pct)),
    asString: () => String(pct),
  }));
  return {
    module: {
      getRemoteConfig: vi.fn(() => ({ fake: "remote-config" })),
      fetchAndActivate,
      getValue,
    },
    getValue,
    fetchAndActivate,
  };
}

const FAKE_APP = { name: "[DEFAULT]", options: { appId: "ff-field-web" } };

/** Flush the microtask + macrotask queue (the emit path is async). */
const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

function deps(
  analytics: FakeAnalytics,
  rc: FakeRemoteConfig,
  extra: Partial<AnalyticsDeps> = {},
): AnalyticsDeps {
  return {
    loadAnalytics: async () => analytics.module,
    loadRemoteConfig: async () => rc.module,
    now: () => 1_700_000_000_000,
    random: () => 0.5,
    // No rAF / no interval in tests — the runtime is driven explicitly.
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    setInterval: () => null,
    clearInterval: () => {},
    ...extra,
  };
}

// --- hash ------------------------------------------------------------

describe("analytics/hash (vector-stable)", () => {
  it("builds the canonical hash input `${uid}:${appId}.${dailySalt}`", () => {
    expect(buildUidHashInput("user-42", "ff-field-web", "2026-11-04")).toBe(
      "user-42:ff-field-web.2026-11-04",
    );
  });

  it("pure-JS SHA-256 matches the known FIPS vectors", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashUid is vector-stable (known input → fixed 16-hex output)", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["user-42", "ff-field-web", "2026-11-04", "c93e5310d78ee4e5"],
      ["user-42", "ff-field-web", "2026-11-05", "031af17286db8fd1"],
      ["", "app", "salt", "0fe2da9e43787dc0"],
      ["user-42", "ff-field-web", "", "97bc0a8c3c026d42"],
      ["ünïcødé-😀", "ff-field-web", "2026-11-04", "541656e869ec36a0"],
    ];
    for (const [uid, appId, salt, expected] of cases) {
      const hash = await hashUid(uid, appId, salt);
      expect(hash).toBe(expected);
      expect(hash).toHaveLength(UID_HASH_LENGTH);
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("the async path and the pure-JS path agree byte-for-byte", async () => {
    const inputs = ["", "abc", "user-42:ff-field-web.2026-11-04", "x".repeat(1000)];
    for (const input of inputs) {
      const async_ = await sha256HexAsync(input);
      expect(async_).toBe(sha256Hex(input));
    }
    // Informational: jsdom does not implement SubtleCrypto, so the
    // pure-JS fallback is what runs there. Both must agree.
    expect(typeof hasWebCryptoSubtle()).toBe("boolean");
  });

  it("encodes UTF-8 correctly (surrogate pairs)", () => {
    expect(Array.from(utf8Bytes("é"))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8Bytes("😀"))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it("derives a stable UTC daily salt", () => {
    expect(dailySaltFor(Date.UTC(2026, 10, 4, 23, 59))).toBe("2026-11-04");
    expect(dailySaltFor(Date.UTC(2026, 10, 5, 0, 1))).toBe("2026-11-05");
  });
});

// --- perf stats ------------------------------------------------------

describe("analytics/perfStats (histogram-bucketed accumulator)", () => {
  it("buckets values into the default frame-time ladder", () => {
    const edges = DEFAULT_BUCKET_EDGES;
    expect(bucketIndexFor(4, edges)).toBe(0);
    expect(bucketIndexFor(8, edges)).toBe(0);
    expect(bucketIndexFor(12, edges)).toBe(1);
    expect(bucketIndexFor(20, edges)).toBe(2);
    expect(bucketIndexFor(40, edges)).toBe(3);
    expect(bucketIndexFor(80, edges)).toBe(4);
    expect(bucketIndexFor(500, edges)).toBe(5);
    expect(bucketLabels(edges)).toEqual([
      "0_8",
      "8_16",
      "16_33",
      "33_50",
      "50_100",
      "gt_100",
    ]);
  });

  it("percentile from a histogram interpolates inside the bucket", () => {
    const edges = [8, 16, 33, 50, 100];
    // 10 samples, all in the first bucket (0..8] → the median sits at
    // the bucket midpoint (4) and the p95 near its upper bound.
    const counts = [10, 0, 0, 0, 0, 0];
    expect(percentileFromHistogram(counts, edges, 0.5)).toBeCloseTo(4, 6);
    expect(percentileFromHistogram(counts, edges, 0.95)).toBeCloseTo(7.6, 6);
    expect(percentileFromHistogram(counts, edges, 0)).toBe(0);
    expect(percentileFromHistogram([0, 0, 0, 0, 0, 0], edges, 0.5)).toBe(0);
  });

  it("accumulates the session frame percentiles from frame-timer readings", () => {
    const acc = createPerfStatsAccumulator();
    for (let i = 0; i < 10; i++) {
      acc.addFrameStats({
        p50: 16,
        p95: 33,
        p99: 50,
        frameEmaMs: 17,
        frameMaxMs: 60,
      });
    }
    const snap = acc.snapshot();
    expect(snap.sampleCount).toBe(10);
    // All p50 readings are exactly 16 → the session p50 lands in the
    // "8_16" bucket and interpolates to 16.
    expect(snap.frameP50).toBeCloseTo(16, 6);
    expect(snap.frameP95).toBeCloseTo(33, 6);
    expect(snap.frameP99).toBeCloseTo(50, 6);
    expect(snap.frameEmaMs).toBe(17);
    expect(snap.frameMaxMs).toBe(60);
    expect(snap.buckets["8_16"]).toBe(10);
    expect(snap.histograms.p95["16_33"]).toBe(10);
  });

  it("reset() clears every sample", () => {
    const acc = createPerfStatsAccumulator();
    acc.addFrameStats({ p50: 10, p95: 20, p99: 30 });
    acc.reset();
    const snap = acc.snapshot();
    expect(snap.sampleCount).toBe(0);
    expect(snap.frameP50).toBe(0);
    expect(Object.values(snap.buckets).every((v) => v === 0)).toBe(true);
  });
});

describe("analytics/perfStats (session timeline)", () => {
  it("computes ifc_to_first_frame from the load-start → first frame", () => {
    const t = createSessionTimeline();
    t.noteLoadStart(1000);
    t.noteLoadComplete(1500);
    t.noteFrameTick(1400); // before load-complete — ignored
    t.noteFrameTick(1600); // the first frame after load-complete
    t.noteFrameTick(1700);
    expect(t.ifcToFirstFrameMs()).toBe(600); // 1600 − 1000
  });

  it("finds the first frame after load-complete even when it is seen late", () => {
    const t = createSessionTimeline();
    t.noteFrameTick(1400);
    t.noteFrameTick(1600);
    t.noteFrameTick(1700);
    t.noteLoadStart(1000);
    t.noteLoadComplete(1500); // discovered after the frames happened
    expect(t.firstFrameTs()).toBe(1600);
    expect(t.ifcToFirstFrameMs()).toBe(600);
  });

  it("fragment_decode_ms falls back to the §5.6 load-complete − load-start proxy", () => {
    const t = createSessionTimeline();
    t.noteLoadStart(1000);
    t.noteLoadComplete(2400);
    expect(t.fragmentDecodeMs()).toBe(1400);
  });

  it("a measured worker span wins over the proxy", () => {
    const t = createSessionTimeline();
    t.noteLoadStart(1000);
    t.noteLoadComplete(2400);
    t.noteWorkerSpanMs(320);
    expect(t.fragmentDecodeMs()).toBe(320);
  });

  it("re-reading the same load breadcrumbs is idempotent", () => {
    const t = createSessionTimeline();
    t.noteLoadStart(1000);
    t.noteLoadComplete(2400);
    t.noteLoadStart(1000);
    t.noteLoadComplete(2400);
    expect(t.fragmentDecodeMs()).toBe(1400);
    expect(t.loadStartTs()).toBe(1000);
  });

  it("returns null when the load was never observed", () => {
    const t = createSessionTimeline();
    expect(t.ifcToFirstFrameMs()).toBeNull();
    expect(t.fragmentDecodeMs()).toBeNull();
  });
});

// --- analytics -------------------------------------------------------

describe("analytics/initAnalytics + rollup", () => {
  beforeEach(() => {
    resetAnalyticsForTests();
  });

  afterEach(() => {
    resetAnalyticsForTests();
    vi.restoreAllMocks();
  });

  it("does not touch the DOM or Firebase before initAnalytics is called", () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    // Nothing has been initialised yet.
    expect(getAnalyticsSamplingPct()).toBe(0);
    expect(isAnalyticsOptIn()).toBe(false);
    expect(addSpy).not.toHaveBeenCalledWith("pagehide", expect.anything());
    expect(analytics.logEvent).not.toHaveBeenCalled();
    expect(rc.fetchAndActivate).not.toHaveBeenCalled();
  });

  it("emits exactly one rollup on pagehide with the DoD shape", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    recordFrameStats({ p50: 16, p95: 33, p99: 50 });
    noteModelLoadStart(1000);
    noteModelLoadComplete(1400);
    recordFrameTick(1500);

    window.dispatchEvent(new Event("pagehide"));
    await flush();

    expect(analytics.logEvent).toHaveBeenCalledTimes(1);
    const [instance, name, params] = analytics.logEvent.mock.calls[0] as [
      unknown,
      string,
      Record<string, string | number>,
    ];
    expect(instance).toEqual({ fake: "analytics-instance" });
    expect(name).toBe(ROLLUP_EVENT_NAME);
    expect(params.frame_p50).toBe(16);
    expect(params.frame_p95).toBe(33);
    expect(params.frame_p99).toBe(50);
    expect(params.ifc_to_first_frame_ms).toBe(500); // 1500 − 1000
    expect(params.fragment_decode_ms).toBe(400); // 1400 − 1000 (proxy)
    expect(params.uid_hash).toBe("c93e5310d78ee4e5");
    expect(params.sampling_applied).toBe(1);
    expect(typeof params.device_tags).toBe("string");
  });

  it("the rollup summary carries the DoD shape", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    const summary: SessionRollupSummary = buildSessionRollup();
    expect(Object.keys(summary).sort()).toEqual(
      [
        "deviceTags",
        "fragmentDecodeMs",
        "frameP50",
        "frameP95",
        "frameP99",
        "ifcToFirstFrameMs",
        "samplingApplied",
        "uidHash",
      ].sort(),
    );
    expect(summary.uidHash).toBe("c93e5310d78ee4e5");
    expect(summary.samplingApplied).toBe(true);
  });

  it("RC pct = 0 → no events at all", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(0);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    expect(getAnalyticsSamplingPct()).toBe(0);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(analytics.logEvent).not.toHaveBeenCalled();
  });

  it("a failing RC fetch is fail-closed (0 % → no events)", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100, { failFetch: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    expect(getAnalyticsSamplingPct()).toBe(0);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(analytics.logEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("opt-in false → no events (crash channels are untouched)", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: false,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    expect(isAnalyticsOptIn()).toBe(false);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(analytics.logEvent).not.toHaveBeenCalled();

    // Flipping the gate back on (the UI toggle) enables the rollup.
    setAnalyticsOptIn(true);
    expect(isAnalyticsOptIn()).toBe(true);
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(analytics.logEvent).toHaveBeenCalledTimes(1);
  });

  it("guards the pagehide + visibilitychange double emit (once per session)", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );

    window.dispatchEvent(new Event("pagehide"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    await flush();

    expect(analytics.logEvent).toHaveBeenCalledTimes(1);
  });

  it("is idempotent (a second init does not re-fetch or re-attach)", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    const config = {
      firebaseApp: FAKE_APP,
      samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
      optIn: true,
    };
    const d = deps(analytics, rc);
    await initAnalytics(config, { deps: d });
    await initAnalytics(config, { deps: d });

    expect(rc.fetchAndActivate).toHaveBeenCalledTimes(1);
    expect(analytics.getAnalytics).toHaveBeenCalledTimes(1);
  });

  it("never throws when Firebase explodes", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const brokenDeps: AnalyticsDeps = {
      ...deps(analytics, rc),
      loadAnalytics: async () => {
        throw new Error("firebase exploded");
      },
    };
    await expect(
      initAnalytics(
        {
          firebaseApp: FAKE_APP,
          samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
          optIn: true,
        },
        { deps: brokenDeps },
      ),
    ).resolves.toBeUndefined();

    window.dispatchEvent(new Event("pagehide"));
    await flush();
    await flush();
    expect(analytics.logEvent).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("drops the event (and warns) when logEvent itself throws", async () => {
    const analytics = fakeAnalytics();
    analytics.logEvent.mockImplementation(() => {
      throw new Error("gtag exploded");
    });
    const rc = fakeRemoteConfig(100);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { deps: deps(analytics, rc) },
    );

    await expect(
      logSessionRollup({
        frameP50: 1,
        frameP95: 2,
        frameP99: 3,
        ifcToFirstFrameMs: null,
        fragmentDecodeMs: null,
        deviceTags: {},
        uidHash: null,
        samplingApplied: true,
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("a manual logSessionRollup cannot bypass the gates", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(0);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { deps: deps(analytics, rc) },
    );

    await logSessionRollup({
      frameP50: 1,
      frameP95: 2,
      frameP99: 3,
      ifcToFirstFrameMs: null,
      fragmentDecodeMs: null,
      deviceTags: {},
      uidHash: null,
      samplingApplied: true,
    });
    expect(analytics.logEvent).not.toHaveBeenCalled();
  });

  it("never sends the raw uid — only the 16-hex hash", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { uid: "user-42", appId: "ff-field-web", dailySalt: "2026-11-04", deps: deps(analytics, rc) },
    );
    expect(getAnalyticsUidHash()).toBe("c93e5310d78ee4e5");
    expect(getAnalyticsUidHash()).not.toContain("user-42");

    window.dispatchEvent(new Event("pagehide"));
    await flush();
    const params = analytics.logEvent.mock.calls[0]?.[2] as Record<string, string>;
    expect(params.uid_hash).toBe("c93e5310d78ee4e5");
    expect(JSON.stringify(params)).not.toContain("user-42");
  });

  it("uses the Remote Config key from the config", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: "custom_sampling_key",
        optIn: true,
      },
      { deps: deps(analytics, rc) },
    );
    expect(rc.getValue).toHaveBeenCalledWith(expect.anything(), "custom_sampling_key");
  });

  it("the frame watch records the first frame after load-complete", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    let rafCb: FrameRequestCallback | null = null;
    let currentNow = 1000;
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      {
        deps: deps(analytics, rc, {
          now: () => currentNow,
          requestAnimationFrame: (cb) => {
            rafCb = cb;
            return 1;
          },
          cancelAnimationFrame: () => {},
        }),
      },
    );

    // The runtime runs only while sampling + opt-in are on.
    expect(rafCb).toBeTypeOf("function");

    noteModelLoadStart(currentNow); // 1000
    currentNow = 1400;
    noteModelLoadComplete(currentNow); // 1400
    currentNow = 1500;
    (rafCb as FrameRequestCallback | null)?.(0); // a rendered frame at 1500

    const summary = buildSessionRollup();
    expect(summary.ifcToFirstFrameMs).toBe(500); // 1500 − 1000
    expect(summary.fragmentDecodeMs).toBe(400); // 1400 − 1000 (proxy)
  });

  it("a measured worker span overrides the §5.6 proxy in the rollup", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { deps: deps(analytics, rc) },
    );

    noteModelLoadStart(1000);
    noteModelLoadComplete(2400);
    noteFragmentDecodeSpan(320);

    const summary = buildSessionRollup();
    expect(summary.fragmentDecodeMs).toBe(320);
    // No frame tick was observed → the load-to-first-frame stays unknown.
    expect(summary.ifcToFirstFrameMs).toBeNull();
  });

  it("compacts the device tags to the GA4 100-char string limit", () => {
    const params = buildRollupEventParams({
      frameP50: 1,
      frameP95: 2,
      frameP99: 3,
      ifcToFirstFrameMs: null,
      fragmentDecodeMs: null,
      deviceTags: {
        gpu: "NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0",
        webgl2: true,
        deviceMemory: 8,
        hardwareConcurrency: 8,
        userAgent: "Mozilla/5.0 (very long user agent string)",
      },
      uidHash: "c93e5310d78ee4e5",
      samplingApplied: true,
    });
    const tags = params.device_tags as string;
    expect(tags.length).toBeLessThanOrEqual(100);
    expect(() => JSON.parse(tags)).not.toThrow();
    expect(params.uid_hash).toBe("c93e5310d78ee4e5");
    expect(params.sampling_applied).toBe(1);
  });

  it("stopAnalytics removes the listeners", async () => {
    const analytics = fakeAnalytics();
    const rc = fakeRemoteConfig(100);
    await initAnalytics(
      {
        firebaseApp: FAKE_APP,
        samplingRemoteConfigKey: DEFAULT_SAMPLING_KEY,
        optIn: true,
      },
      { deps: deps(analytics, rc) },
    );
    stopAnalytics();
    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(analytics.logEvent).not.toHaveBeenCalled();
  });

  it("the opt-in gate never touches the crash channels (A + B)", () => {
    const reporter = { captureException: vi.fn() };
    setErrorReporter(reporter);
    setAnalyticsOptIn(false);
    expect(isAnalyticsOptIn()).toBe(false);
    // The Channel A reporter is untouched by the analytics opt-in.
    expect(getErrorReporter()).toBe(reporter);
    setAnalyticsOptIn(true);
    expect(getErrorReporter()).toBe(reporter);
    setErrorReporter(null);
  });

  it("never imports firebase statically (zero load-time firebase cost)", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "../src/analytics/index.ts"), "utf8");
    // Only dynamic `import("firebase/...")` calls are allowed.
    expect(source).not.toMatch(/^\s*import\s[^\n]*from\s*["']firebase/m);
    expect(source).not.toMatch(/require\(["']firebase/);
    expect(source).toContain('import("firebase/analytics")');
    expect(source).toContain('import("firebase/remote-config")');
  });
});
