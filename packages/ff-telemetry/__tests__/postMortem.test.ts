import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  openForensicsStore,
  requestPersistentStorage,
  createBundleIdbStorage,
  persistBundleToStorage,
  resetIdbPersistThrottle,
  runPostMortem,
  createPostMortemDeps,
  buildRendererReportFromBundle,
  truncateBundleToFit,
  utf8ByteLength,
  MAX_BUNDLE_BYTES,
  BOOT_FLAG_KEY,
  BUNDLE_KEY,
  createTelemetry,
  type IdbStore,
  type TelemetryStorage,
  type TelemetryBundle,
  type PostMortemDeps,
} from "../src/index";

/** In-memory TelemetryStorage (jsdom localStorage never touched). */
function memoryStorage(
  initial: Record<string, string> = {},
): TelemetryStorage & { _map: Map<string, string> } {
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
  };
}

/** A synchronous, in-memory IdbStore for deterministic persist tests.
 *  `failPut` forces put callbacks to report failure (quota path). */
function fakeIdbStore(): IdbStore & {
  data: Map<string, unknown>;
  failPut: boolean;
} {
  const data = new Map<string, unknown>();
  const store: IdbStore & { data: Map<string, unknown>; failPut: boolean } = {
    data,
    failPut: false,
    get(key, cb) {
      cb(data.get(key));
    },
    put(key, value, cb) {
      if (store.failPut) {
        cb?.(false, "QuotaExceededError");
      } else {
        data.set(key, value);
        cb?.(true);
      }
    },
    remove(key, cb) {
      data.delete(key);
      cb?.(true);
    },
    close() {
      data.clear();
    },
  };
  return store;
}

/** Track opened stores so afterEach closes every connection. */
const openedStores: IdbStore[] = [];
function openStore(dbName?: string): IdbStore {
  const store = openForensicsStore(dbName ? { dbName } : undefined);
  openedStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openedStores.splice(0)) {
    store.close();
  }
});

/** Await an IdbStore.get as a promise (never rejects). */
function getValue(store: IdbStore, key: string): Promise<unknown> {
  return new Promise((resolve) => store.get(key, (v) => resolve(v)));
}
/** Await an IdbStore.put as a promise (never rejects). */
function putValue(
  store: IdbStore,
  key: string,
  value: unknown,
): Promise<boolean> {
  return new Promise((resolve) =>
    store.put(key, value, (ok) => resolve(ok)),
  );
}

const sampleBundle: TelemetryBundle = {
  startedAt: 1,
  breadcrumbs: [
    { ts: 1, category: "model", action: "load-start", data: { file: "a.ifc" } },
  ],
  snapshots: [{ ts: 2, key: "renderer", data: { drawCalls: 42 } }],
  deviceLostCount: 1,
  tags: { gpu: "unknown" },
};

describe("requestPersistentStorage", () => {
  it("never throws when navigator.storage.persist is absent", () => {
    expect(() => requestPersistentStorage()).not.toThrow();
  });

  it("swallows a rejected persist() promise (best-effort)", async () => {
    const persist = vi.fn(() => Promise.reject(new Error("denied")));
    const original = (navigator as Navigator & { storage?: StorageManager })
      .storage;
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { persist },
    });
    try {
      expect(() => requestPersistentStorage()).not.toThrow();
      // let any microtask rejection surface (should be swallowed)
      await Promise.resolve();
      expect(persist).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: original,
      });
    }
  });
});

describe("openForensicsStore (IndexedDB wrapper)", () => {
  it("round-trips put → get and removes cleanly", async () => {
    let seq = 0;
    const store = openStore(`ff-forensics-rt-${++seq}`);
    expect(await putValue(store, "k1", { hello: "world" })).toBe(true);
    expect(await getValue(store, "k1")).toEqual({ hello: "world" });

    await new Promise<boolean>((res) => store.remove("k1", (ok) => res(ok)));
    expect(await getValue(store, "k1")).toBeUndefined();
  });

  it("reuses the schema without throwing across an open/close/open", async () => {
    const first = openStore("ff-forensics-reopen");
    await putValue(first, "k", "v1");
    first.close();

    const second = openStore("ff-forensics-reopen");
    expect(await getValue(second, "k")).toBe("v1");
  });

  it("degrades to never-throw when indexedDB.open throws synchronously", async () => {
    const real = globalThis.indexedDB;
    const originalOpen = real.open;
    (real as { open: unknown }).open = () => {
      throw new Error("SecurityError: the operation is insecure");
    };
    let store: IdbStore | null = null;
    try {
      store = openStore();
      // put must settle "failed" without throwing; get settles undefined.
      expect(await putValue(store, "k", "v")).toBe(false);
      expect(await getValue(store, "k")).toBeUndefined();
    } finally {
      (real as { open: unknown }).open = originalOpen;
      store?.close();
    }
  });

  it("degrades to never-throw when indexedDB.open fires onerror", async () => {
    const real = globalThis.indexedDB;
    const originalOpen = real.open;
    (real as { open: unknown }).open = () => {
      const req = {
        result: undefined,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      } as unknown as IDBOpenDBRequest;
      setTimeout(() => {
        (req as unknown as {
          onerror: ((e: Event) => void) | null;
        }).onerror?.(new Event("error"));
      }, 0);
      return req;
    };
    let store: IdbStore | null = null;
    try {
      store = openStore();
      await new Promise((r) => setTimeout(r, 10)); // let onerror fire
      expect(await getValue(store, "k")).toBeUndefined();
    } finally {
      (real as { open: unknown }).open = originalOpen;
      store?.close();
    }
  });
});

describe("createBundleIdbStorage", () => {
  it("write → read round-trips through IDB", async () => {
    const bs = createBundleIdbStorage(fakeIdbStore(), memoryStorage());
    const ok = await new Promise<boolean>((res) => bs.write("hello", (o) => res(o)));
    expect(ok).toBe(true);
    const json = await new Promise<string | null>((res) => bs.read(res));
    expect(json).toBe("hello");
  });

  it("read falls back to localStorage when IDB is empty", async () => {
    const fallback = memoryStorage({ [BUNDLE_KEY]: "local-json" });
    const bs = createBundleIdbStorage(fakeIdbStore(), fallback);
    const json = await new Promise<string | null>((res) => bs.read(res));
    expect(json).toBe("local-json");
  });

  it("write falls back to localStorage when IDB put fails (quota-denied)", async () => {
    const store = fakeIdbStore();
    store.failPut = true;
    const fallback = memoryStorage();
    const bs = createBundleIdbStorage(store, fallback);

    const ok = await new Promise<boolean>((res) => bs.write("pretty-big", (o) => res(o)));
    expect(ok).toBe(false);
    expect(fallback.getItem(BUNDLE_KEY)).toBe("pretty-big");
  });

  it("clear removes both layers and calls back", async () => {
    const store = fakeIdbStore();
    const fallback = memoryStorage({ [BUNDLE_KEY]: "fallback" });
    const bs = createBundleIdbStorage(store, fallback);
    store.data.set("bundle", "idb");
    await new Promise<void>((res) => bs.clear(res));
    expect(store.data.has("bundle")).toBe(false);
    expect(fallback.getItem(BUNDLE_KEY)).toBeNull();
  });
});

describe("persistBundleToStorage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetIdbPersistThrottle();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles writes to ≥5s and skips when unchanged", () => {
    const store = fakeIdbStore();
    const bs = createBundleIdbStorage(store, memoryStorage());
    const t = createTelemetry();
    t.breadcrumb("a", "1");

    persistBundleToStorage(t, bs);
    const first = store.data.get("bundle") as string;
    expect(first).toBeTruthy();

    persistBundleToStorage(t, bs); // unchanged → skip
    expect(store.data.get("bundle")).toBe(first);

    t.breadcrumb("a", "2");
    persistBundleToStorage(t, bs); // within throttle window → skip
    expect(store.data.get("bundle")).toBe(first);

    vi.advanceTimersByTime(5_100);
    persistBundleToStorage(t, bs); // past window → writes
    expect(store.data.get("bundle")).not.toBe(first);
  });

  it("force bypasses the throttle (immediate write)", () => {
    const store = fakeIdbStore();
    const bs = createBundleIdbStorage(store, memoryStorage());
    const t = createTelemetry();
    t.breadcrumb("a", "1");
    persistBundleToStorage(t, bs);
    const first = store.data.get("bundle");

    t.breadcrumb("a", "2");
    persistBundleToStorage(t, bs, true);
    expect(store.data.get("bundle")).not.toBe(first);
  });

  it("caps the payload at ≤512KB by truncating oldest breadcrumbs", () => {
    const store = fakeIdbStore();
    const bs = createBundleIdbStorage(store, memoryStorage());
    const t = createTelemetry({ maxBreadcrumbs: 2000 });
    for (let i = 0; i < 600; i++) {
      t.breadcrumb("model", `load-${i}`, { blob: "x".repeat(2000) });
    }
    persistBundleToStorage(t, bs, true);
    const json = store.data.get("bundle") as string;
    expect(json).toBeTruthy();
    expect(utf8ByteLength(json)).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
    const parsed = JSON.parse(json) as TelemetryBundle;
    expect(parsed.breadcrumbs.length).toBeLessThan(600);
  });

  it("emits storage:quota + localStorage fallback on IDB failure", () => {
    const store = fakeIdbStore();
    store.failPut = true;
    const fallback = memoryStorage();
    const bs = createBundleIdbStorage(store, fallback);
    const t = createTelemetry();
    t.breadcrumb("a", "1");

    persistBundleToStorage(t, bs, true);
    // fallback written + storage:quota breadcrumb recorded
    expect(fallback.getItem(BUNDLE_KEY)).toBeTruthy();
    expect(
      t
        .getBundle()
        .breadcrumbs.some((c) => c.category === "storage" && c.action === "quota"),
    ).toBe(true);
  });
});

describe("truncateBundleToFit", () => {
  it("drops oldest breadcrumbs first to fit the budget", () => {
    const bundle: TelemetryBundle = {
      startedAt: 1,
      breadcrumbs: [
        { ts: 1, category: "a", action: "old", data: { p: "x".repeat(10000) } },
        { ts: 2, category: "a", action: "new", data: { p: "y".repeat(10) } },
      ],
      snapshots: [],
      deviceLostCount: 0,
      tags: {},
    };
    const out = truncateBundleToFit(bundle, 2000);
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(2000);
    expect(out.breadcrumbs.map((b) => b.action)).toEqual(["new"]);
  });

  it("returns an empty-ring minimal bundle when a single item is oversized", () => {
    const bundle: TelemetryBundle = {
      startedAt: 1,
      breadcrumbs: [
        { ts: 1, category: "a", action: "huge", data: { p: "x".repeat(100000) } },
      ],
      snapshots: [],
      deviceLostCount: 3,
      tags: { gpu: "unknown" },
    };
    const out = truncateBundleToFit(bundle, 200);
    expect(out.breadcrumbs).toEqual([]);
    expect(out.snapshots).toEqual([]);
    expect(out.deviceLostCount).toBe(3);
    // Empty-ring scalar-only floor still fits under the (larger) budget.
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(200);
  });
});

describe("buildRendererReportFromBundle", () => {
  it("renders the device-lost header + snapshots", () => {
    const report = buildRendererReportFromBundle(sampleBundle);
    expect(report).toContain("Lost device: 1 times");
    expect(report).toContain("renderer");
  });
});

describe("runPostMortem", () => {
  function makeReporter() {
    return vi.fn<(bundle: TelemetryBundle, report: string) => Promise<void>>(
      async () => {
        /* acked */
      },
    );
  }

  it("no-ops on a clean boot (no stale flag)", async () => {
    const report = makeReporter();
    let flag = "";
    const deps: PostMortemDeps = {
      readFlag: () => (flag === "" ? null : flag),
      readBundle: async () => sampleBundle,
      clearFlag: () => {
        flag = "";
      },
      clearBundle: async () => {},
      reporter: { report },
    };
    await runPostMortem(deps);
    expect(report).not.toHaveBeenCalled();
  });

  it("uploads exactly once on ack, then clears flag + bundle", async () => {
    const report = makeReporter();
    let flag = "999";
    let cleared = false;
    const deps: PostMortemDeps = {
      readFlag: () => flag,
      readBundle: async () => sampleBundle,
      clearFlag: () => {
        flag = "";
      },
      clearBundle: async () => {
        cleared = true;
      },
      reporter: { report },
    };
    await runPostMortem(deps);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual(sampleBundle);
    expect(report.mock.calls[0][1]).toContain("Lost device: 1 times");
    expect(flag).toBe("");
    expect(cleared).toBe(true);
  });

  it("leaves flag + bundle for next boot when the reporter throws", async () => {
    const report = vi.fn<(bundle: TelemetryBundle, report: string) => Promise<void>>(
      async () => {
        throw new Error("network down");
      },
    );
    let flag = "999";
    let cleared = false;
    const deps: PostMortemDeps = {
      readFlag: () => flag,
      readBundle: async () => sampleBundle,
      clearFlag: () => {
        flag = "";
      },
      clearBundle: async () => {
        cleared = true;
      },
      reporter: { report },
    };
    await expect(runPostMortem(deps)).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledTimes(1);
    expect(flag).toBe("999"); // NOT cleared — retry next boot
    expect(cleared).toBe(false);
  });

  it("clears the flag (but not the reporter) when flag is stale but no bundle", async () => {
    const report = makeReporter();
    let flag = "999";
    const deps: PostMortemDeps = {
      readFlag: () => flag,
      readBundle: async () => null,
      clearFlag: () => {
        flag = "";
      },
      clearBundle: async () => {},
      reporter: { report },
    };
    await runPostMortem(deps);
    expect(report).not.toHaveBeenCalled();
    expect(flag).toBe(""); // cleared so we never re-upload "nothing"
  });
});

describe("createPostMortemDeps (end-to-end wiring)", () => {
  it("reads the IDB bundle, uploads once, clears flag + bundle", async () => {
    const store = fakeIdbStore();
    const fallback = memoryStorage();
    const bs = createBundleIdbStorage(store, fallback);
    const flagStore = memoryStorage({ [BOOT_FLAG_KEY]: "999" });

    const ok = await new Promise<boolean>((res) =>
      bs.write(JSON.stringify(sampleBundle), (o) => res(o)),
    );
    expect(ok).toBe(true);

    const report = vi.fn<(bundle: TelemetryBundle, report: string) => Promise<void>>(
      async () => {},
    );
    const deps = createPostMortemDeps(flagStore, bs, { report });
    await runPostMortem(deps);

    expect(report).toHaveBeenCalledTimes(1);
    expect(flagStore.getItem(BOOT_FLAG_KEY)).toBeFalsy();
    // bundle cleared → IDB reads null (fallback was empty too)
    const left = await new Promise<string | null>((res) => bs.read(res));
    expect(left).toBeNull();
  });
});