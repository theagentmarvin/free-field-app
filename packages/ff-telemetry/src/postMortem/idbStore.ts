// postMortem/idbStore.ts — a hand-rolled, callback-driven IndexedDB
// wrapper for the launch-crash forensics store.
//
// The store is intentionally tiny (no Dexie dependency) and never uses
// Promises: every operation is void and results flow through callbacks
// so no async rejection can ever leak into app code (spec §9 risk 1 —
// "IDB write via request.onsuccess NEVER await-into-app-code"). Every
// IDB event handler is safe()-wrapped so a quota denial, a private-mode
// failure, or a malformed store can never throw.
//
// The database is named `ff-forensics` (spec §9 risk 2) so it never
// collides with Dexie's `ff-data` and its version schema. Values are
// capped at ≤ 512 KB by the caller (boot.ts) before they get here.

import { safe } from "../safe";

/** Forensic DB name — deliberately distinct from Dexie `ff-data`. */
export const FORENSICS_DB_NAME = "ff-forensics";
/** Single object store holding the forensic records. */
export const FORENSICS_STORE_NAME = "forensics";
/** Schema version (independent of Dexie's versioning). */
export const FORENSICS_DB_VERSION = 1;
/** Key under which the last bundle watermark is stored. */
export const BUNDLE_IDB_KEY = "bundle";

/** Injectable `indexedDB` factory surface (subset). Lets tests inject
 *  a factory or monkeypatch `indexedDB.open` to fire `onerror` and
 *  prove the quota-denied/private-mode path never throws. */
export interface IdbFactoryLike {
  open(name: string, version?: number): IDBOpenDBRequest;
}

export interface ForensicsStoreOptions {
  dbName?: string;
  storeName?: string;
  version?: number;
  /** Inject the IDB factory (tests / SSR without indexedDB). Defaults
   *  to `globalThis.indexedDB` when present, else a no-op store. */
  idb?: IdbFactoryLike | null;
}

/** Result callback for a put: `ok` plus the underlying error name. */
export type IdbPutCallback = (ok: boolean, errorName?: string) => void;

/** A callback-driven IndexedDB store. Every method is void; results
 *  flow through callbacks so no async work can reject into app code. */
export interface IdbStore {
  get(key: string, cb: (value: unknown) => void): void;
  put(key: string, value: unknown, cb?: IdbPutCallback): void;
  remove(key: string, cb?: (ok: boolean) => void): void;
  close(): void;
}

/** Best-effort `navigator.storage.persist()` — request persistent
 *  storage so the forensic DB survives eviction. Fire-and-forget; never
 *  throws; no-ops when the API is absent (spec §9 risk 2). */
export function requestPersistentStorage(): void {
  safe(() => {
    if (typeof navigator === "undefined") return;
    const storage = (navigator as Navigator & { storage?: StorageManager })
      .storage;
    if (!storage || typeof storage.persist !== "function") return;
    const result = storage.persist();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      (result as Promise<unknown>).catch(() => {
        /* best-effort: ignore rejection */
      });
    }
  }, "requestPersistentStorage failed");
}

/** Resolve the IDB factory: explicit injection wins, then the global.
 *  Never throws — absent `indexedDB` (SSR/private mode) yields null. */
function resolveFactory(
  idb: IdbFactoryLike | null | undefined,
): IdbFactoryLike | null {
  if (idb !== undefined) return idb;
  try {
    return typeof indexedDB === "undefined" ? null : (indexedDB as IdbFactoryLike);
  } catch {
    return null;
  }
}

/**
 * Open (lazily, via IDB events) the forensic store. Always returns a
 * usable `IdbStore` synchronously; operations issued before the open
 * completes are queued and flushed on success, or settled as "failed"
 * on open error / no factory. `close()` ends the connection cleanly so
 * tests never hang on open handles or leak state between tests.
 */
export function openForensicsStore(
  options: ForensicsStoreOptions = {},
): IdbStore {
  const dbName = options.dbName ?? FORENSICS_DB_NAME;
  const storeName = options.storeName ?? FORENSICS_STORE_NAME;
  const version = options.version ?? FORENSICS_DB_VERSION;
  const factory = resolveFactory(options.idb);

  let db: IDBDatabase | null = null;
  let openFailed = factory === null;
  let closed = false;

  const pending: Array<() => void> = [];

  const flush = (): void => {
    const ops = pending.splice(0);
    for (const op of ops) safe(op, "flush pending idb op failed");
  };

  if (factory) {
    safe(() => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(dbName, version);
      } catch {
        openFailed = true;
        flush();
        return;
      }
      request.onupgradeneeded = () => {
        safe(() => {
          const d = request.result;
          if (d && !d.objectStoreNames.contains(storeName)) {
            d.createObjectStore(storeName);
          }
        }, "idb onupgradeneeded failed");
      };
      request.onsuccess = () => {
        safe(() => {
          db = request.result;
          flush();
        }, "idb open success handler failed");
      };
      request.onerror = () => {
        safe(() => {
          openFailed = true;
          db = null;
          flush();
        }, "idb open error handler failed");
      };
      // request.onblocked deliberately unhandled — another tab holds the
      // old schema version; the next boot's open will retry. Nothing to
      // do here other than keep the request alive.
    }, "openForensicsStore failed");
  }

  /** Route an operation through the store once the DB is ready. When
   *  closed / failed, `settle` runs immediately (failed result). */
  function withStore(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore, tx: IDBTransaction) => void,
    settle: () => void,
  ): void {
    if (closed) {
      settle();
      return;
    }
    if (openFailed) {
      settle();
      return;
    }
    if (db === null) {
      pending.push(() => withStore(mode, body, settle));
      return;
    }
    safe(() => {
      const current = db;
      if (!current) {
        settle();
        return;
      }
      const tx = current.transaction(storeName, mode);
      let store: IDBObjectStore;
      try {
        store = tx.objectStore(storeName);
      } catch {
        settle();
        return;
      }
      body(store, tx);
      tx.onerror = () => {
        // Swallowed — request-level onerror handlers already report
        // failures; a transaction-level abort is a no-op here.
      };
    }, "idb transaction failed");
  }

  return {
    get(key, cb) {
      withStore(
        "readonly",
        (store) => {
          const req = store.get(key);
          req.onsuccess = () =>
            safe(() => cb(req.result), "idb get success cb failed");
          req.onerror = () =>
            safe(() => cb(undefined), "idb get error cb failed");
        },
        () => safe(() => cb(undefined), "idb get settle cb failed"),
      );
    },

    put(key, value, cb) {
      withStore(
        "readwrite",
        (store) => {
          try {
            const req = store.put(value, key);
            req.onsuccess = () =>
              safe(() => cb?.(true), "idb put success cb failed");
            req.onerror = () => {
              const errorName = safe(
                () => req.error?.name,
                "idb put error name failed",
              );
              safe(
                () => cb?.(false, errorName ?? undefined),
                "idb put error cb failed",
              );
            };
          } catch {
            cb?.(false);
          }
        },
        () => cb?.(false),
      );
    },

    remove(key, cb) {
      withStore(
        "readwrite",
        (store) => {
          try {
            const req = store.delete(key);
            req.onsuccess = () =>
              safe(() => cb?.(true), "idb remove success cb failed");
            req.onerror = () =>
              safe(() => cb?.(false), "idb remove error cb failed");
          } catch {
            cb?.(false);
          }
        },
        () => cb?.(false),
      );
    },

    close() {
      closed = true;
      safe(() => {
        if (db) {
          db.close();
          db = null;
        }
      }, "idb close failed");
    },
  };
}