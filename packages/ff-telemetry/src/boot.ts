// Boot forensics — launch-crash detection + bundle persist.
//
// Crown jewel #2: when the app starts we raise a boot flag;
// if that flag is still raised on the NEXT launch we know the
// previous process died before clearing it (crash / hard kill). The
// last persisted bundle is then surfaced to make the forensic record
// for support work.

import { safe } from "./safe";
import type { Telemetry, TelemetryBundle } from "./telemetry";
import { BUNDLE_IDB_KEY, type IdbStore } from "./postMortem/idbStore";

/** Injected storage contract. Defaults to a try/catch-guarded
 *  localStorage wrapper so jsdom / quota / private-mode never throw. */
export interface TelemetryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** Optional clear hook. Falls back to `setItem(key, "")` when absent. */
  removeItem?(key: string): void;
}

export const BOOT_FLAG_KEY = "ff.boot.v1";
export const BUNDLE_KEY = "ff.bundle.v1";
export const PERSIST_THROTTLE_MS = 5_000;

/** A localStorage wrapper that can never throw. When `window` or
 *  `localStorage` is missing (node/jsdom without storage) it degrades
 *  to an in-memory map so callers never have to null-check. */
export function localStorageStorage(): TelemetryStorage {
  const memory = new Map<string, string>();
  const hasLocalStorage = (() => {
    try {
      return (
        typeof window !== "undefined" &&
        typeof window.localStorage !== "undefined"
      );
    } catch {
      return false;
    }
  })();

  return {
    getItem(key) {
      return safe(() => {
        if (hasLocalStorage) return window.localStorage.getItem(key);
        return memory.get(key) ?? null;
      }, "storage.getItem failed") ?? null;
    },
    setItem(key, value) {
      safe(() => {
        if (hasLocalStorage) window.localStorage.setItem(key, String(value));
        else memory.set(key, String(value));
      }, "storage.setItem failed");
    },
    removeItem(key) {
      safe(() => {
        if (hasLocalStorage) window.localStorage.removeItem(key);
        else memory.delete(key);
      }, "storage.removeItem failed");
    },
  };
}

let defaultStorageInstance: TelemetryStorage | null = null;
function defaultStorage(): TelemetryStorage {
  if (defaultStorageInstance === null) {
    defaultStorageInstance = localStorageStorage();
  }
  return defaultStorageInstance;
}

/** Clear the boot flag using removeItem when available, otherwise
 *  an empty `setItem` (an empty string reads back falsy). */
function clearFlag(storage: TelemetryStorage): void {
  if (typeof storage.removeItem === "function") {
    storage.removeItem(BOOT_FLAG_KEY);
  } else {
    storage.setItem(BOOT_FLAG_KEY, "");
  }
}

/**
 * Install the launch-crash boot flag.
 *
 * - If `ff.boot.v1` is already present → the previous session died
 *   → `breadcrumb("session", "previous-killed")` + surface the last
 *   persisted bundle under a `"previous-session"` snapshot.
 * - Raise the flag, then clear it after `healthyMs` (unref'd so we
 *   don't hold the event loop open).
 */
export function installBootFlag(
  telemetry: Telemetry,
  storage?: TelemetryStorage,
  healthyMs: number = 10_000,
): void {
  safe(() => {
    const s = storage ?? defaultStorage();

    const existing = s.getItem(BOOT_FLAG_KEY);
    // Truthy check: a cleared flag is either removed or "" — both falsy.
    if (existing) {
      telemetry.breadcrumb("session", "previous-killed");
      const last = safe(() => s.getItem(BUNDLE_KEY), "read last bundle failed");
      if (last) {
        const parsed = safe(() => JSON.parse(last) as TelemetryBundle, "parse last bundle failed");
        if (parsed) {
          telemetry.snapshot("previous-session", parsed as unknown as Record<string, unknown>);
        }
      }
    }

    s.setItem(BOOT_FLAG_KEY, String(Date.now()));

    const timer = setTimeout(() => {
      safe(() => clearFlag(s), "clear boot flag failed");
    }, Math.max(0, healthyMs));

    // Do not hold the event loop open for a slow/forensic timer.
    const unref = (timer as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(timer);
  }, "installBootFlag failed");
}

// Persist throttle state (module-level — one throttle per realm).
let lastPersistAt = 0;
let lastPersistJson = "";

/**
 * Write `getBundle()` JSON to `ff.bundle.v1`. Throttled to ≥ 5 s
 * between writes, and skipped entirely when the serialized bundle is
 * unchanged. `force` bypasses the throttle (used by the error
 * listeners, which must persist immediately even inside a burst).
 */
export function persist(
  telemetry: Telemetry,
  storage?: TelemetryStorage,
  force: boolean = false,
): void {
  safe(() => {
    const s = storage ?? defaultStorage();
    const json = safe(() => JSON.stringify(telemetry.getBundle()), "stringify bundle failed");
    if (json === undefined) return;
    if (json === lastPersistJson) return; // unchanged → skip

    const now = Date.now();
    if (!force && lastPersistJson !== "" && now - lastPersistAt < PERSIST_THROTTLE_MS) {
      return; // throttled
    }

    lastPersistAt = now;
    lastPersistJson = json;
    s.setItem(BUNDLE_KEY, json);
  }, "persist failed");
}

/** Test/support helper: reset the module-level persist throttle.
 *  (Cheap insurance for tests that assert the ≥ 5 s behaviour.) */
export function resetPersistThrottle(): void {
  lastPersistAt = 0;
  lastPersistJson = "";
}

// --- Wave 18 U4: IndexedDB persist + post-mortem storage adapter ----
//
// v1 persists the bundle to localStorage; the boot flag stays there
// (synchronous read at boot, §5.3). In `indexeddb` mode the bundle
// watermarks move to the `ff-forensics` IDB store, capped ≤ 512 KB,
// with a graceful QuotaExceededError/private-mode fallback back to the
// v1 localStorage key (spec §9 risk 2). Neither path may ever throw.

/** Hard cap on the serialized bundle value size (spec §9 risk 2). */
export const MAX_BUNDLE_BYTES = 512 * 1024;

/** A persisted bundle = the v1 bundle shape + one `persistedAt` ts
 *  (the spec's watermark: reuse the v1 shape, add no other fields). */
export interface PersistedBundle extends TelemetryBundle {
  persistedAt: number;
}

/** UTF-8 byte length of a string (falls back to UTF-16 length). */
export function utf8ByteLength(str: string): number {
  try {
    return typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(str).length
      : str.length;
  } catch {
    return str.length;
  }
}

/** Truncate the bundle's ring buffers (oldest-first) until its JSON
 *  fits under `maxBytes`. Falls back to an empty-ring minimal bundle
 *  (scalars only) when a single item alone is oversized. Never throws. */
export function truncateBundleToFit(
  bundle: TelemetryBundle,
  maxBytes: number = MAX_BUNDLE_BYTES,
): TelemetryBundle {
  return (
    safe(() => {
      const budget =
        Number.isFinite(maxBytes) && maxBytes > 0
          ? Math.floor(maxBytes)
          : MAX_BUNDLE_BYTES;

      const sizeOf = (b: TelemetryBundle): number => {
        const json = safe(() => JSON.stringify(b), "sizeOf stringify failed");
        return json === undefined ? Number.MAX_SAFE_INTEGER : utf8ByteLength(json);
      };

      if (sizeOf(bundle) <= budget) return bundle;

      const crumbs = [...(bundle.breadcrumbs ?? [])];
      const snaps = [...(bundle.snapshots ?? [])];

      // Drop oldest breadcrumbs first (most voluminous, least "latest").
      while (crumbs.length > 0) {
        crumbs.shift();
        if (sizeOf({ ...bundle, breadcrumbs: crumbs, snapshots: snaps }) <= budget) {
          return { ...bundle, breadcrumbs: crumbs, snapshots: snaps };
        }
      }
      // Then oldest snapshots.
      while (snaps.length > 0) {
        snaps.shift();
        if (sizeOf({ ...bundle, breadcrumbs: crumbs, snapshots: snaps }) <= budget) {
          return { ...bundle, breadcrumbs: crumbs, snapshots: snaps };
        }
      }
      // A single entry alone is gargantuan — keep only the non-negotiable
      // scalar fields so we ALWAYS fit under the cap.
      return {
        startedAt: bundle.startedAt,
        breadcrumbs: [],
        snapshots: [],
        deviceLostCount: bundle.deviceLostCount,
        tags: {},
      };
    }, "truncateBundleToFit failed") ?? bundle
  );
}

/** The callback-driven bundle storage surface used by the post-mortem
 *  path. `read` prefers IDB and falls back to localStorage; `write`
 *  falls back to localStorage on IDB failure; `clear` clears both. */
export interface BundleStorage {
  write(
    json: string,
    onResult?: (ok: boolean, errorName?: string) => void,
  ): void;
  read(cb: (json: string | null) => void): void;
  clear(onDone?: () => void): void;
  close(): void;
}

/** Wrap an `IdbStore` + localStorage fallback into a `BundleStorage`.
 *  The fallback is the same `ff.bundle.v1` key v1 uses, so a quota
 *  denial degrades exactly to the v1 behaviour (never throws). */
export function createBundleIdbStorage(
  idbStore: IdbStore,
  fallback: TelemetryStorage = defaultStorage(),
): BundleStorage {
  return {
    write(json, onResult) {
      idbStore.put(BUNDLE_IDB_KEY, json, (ok, errorName) => {
        if (ok) {
          onResult?.(true);
          return;
        }
        // Quota / private-mode denial → v1 localStorage path.
        safe(
          () => fallback.setItem(BUNDLE_KEY, json),
          "idb fallback setItem failed",
        );
        onResult?.(false, errorName);
      });
    },
    read(cb) {
      idbStore.get(BUNDLE_IDB_KEY, (value) => {
        if (typeof value === "string" && value.length > 0) {
          cb(value);
          return;
        }
        cb(fallback.getItem(BUNDLE_KEY));
      });
    },
    clear(onDone) {
      idbStore.remove(BUNDLE_IDB_KEY, () => {
        safe(() => {
          if (typeof fallback.removeItem === "function") {
            fallback.removeItem(BUNDLE_KEY);
          } else {
            fallback.setItem(BUNDLE_KEY, "");
          }
        }, "idb clear fallback failed");
        onDone?.();
      });
    },
    close() {
      idbStore.close();
    },
  };
}

// IDB persist throttle state (module-level — one throttle per realm,
// independent of the v1 localStorage persist throttle).
let lastIdbPersistAt = 0;
let lastIdbPersistJson = "";

/** Build the persisted payload, truncating the ring to fit the cap.
 *  The `persistedAt` field itself costs a few bytes, so the core is
 *  truncated with a small margin to keep the FINAL payload ≤ cap. */
function buildPersistedPayload(
  bundle: TelemetryBundle,
  maxBytes: number,
): PersistedBundle {
  const persistedAt = Date.now();
  const withTag = (b: TelemetryBundle): PersistedBundle => ({
    ...b,
    persistedAt,
  });

  const sizeOf = (b: PersistedBundle): number => {
    const json = safe(() => JSON.stringify(b), "payload stringify failed");
    return json === undefined ? Number.MAX_SAFE_INTEGER : utf8ByteLength(json);
  };

  if (sizeOf(withTag(bundle)) <= maxBytes) return withTag(bundle);

  const truncated = truncateBundleToFit(bundle, Math.max(0, maxBytes - 64));
  return withTag(truncated);
}

/** Write the current bundle to the forensic (IDB) store, throttled to
 *  ≥ 5 s and skipped when unchanged — mirroring v1 `persist`. The write
 *  is capped ≤ 512 KB and, on IDB failure (quota/private-mode), falls
 *  back to localStorage and emits a `storage:quota` breadcrumb. */
export function persistBundleToStorage(
  telemetry: Telemetry,
  bundleStorage: BundleStorage,
  force: boolean = false,
): void {
  safe(() => {
    const bundle = telemetry.getBundle();
    if (!bundle) return;

    const payload = buildPersistedPayload(bundle, MAX_BUNDLE_BYTES);
    const json = safe(() => JSON.stringify(payload), "stringify payload failed");
    if (json === undefined) return;

    if (json === lastIdbPersistJson) return; // unchanged → skip

    const now = Date.now();
    if (
      !force &&
      lastIdbPersistJson !== "" &&
      now - lastIdbPersistAt < PERSIST_THROTTLE_MS
    ) {
      return; // throttled
    }

    lastIdbPersistAt = now;
    lastIdbPersistJson = json;

    bundleStorage.write(json, (ok) => {
      if (!ok) {
        // Degraded: fell back to localStorage. Emit the quota crumb so
        // the forensic record explains WHY the bundle wasn't in IDB.
        telemetry.breadcrumb("storage", "quota", { fallback: "localStorage" });
      }
    });
  }, "persistBundleToStorage failed");
}

/** Test/support helper: reset the module-level IDB persist throttle. */
export function resetIdbPersistThrottle(): void {
  lastIdbPersistAt = 0;
  lastIdbPersistJson = "";
}