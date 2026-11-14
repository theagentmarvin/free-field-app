import { useMemo } from "react";
import { getGlobalTelemetry, safe } from "@ff/telemetry";
import { getFirestore } from "firebase/firestore";
import { getDownloadURL, getStorage, ref, uploadBytes } from "firebase/storage";
import type { FirebaseApp } from "firebase/app";
import type { OutboxRecord } from "@ff/types";

import { useAuthContext } from "@ff/auth";
import { db as localDb } from "@ff/data/db/database";
import {
  ACTIVE_OUTBOX_STATES,
  getDemoTaskSource,
  getTaskBlobStore,
  OutboxEngine,
  createTaskExecutor,
  makeDexieDraftTable,
  makeDexieOutboxStore,
  outboxBlobKeys,
  type BlobSource,
  type OutboxClock,
  type OutboxTransition,
  type TaskBlobStore,
} from "@ff/tasks";

/**
 * Outbox engine wiring for the app (plan §4).
 *
 * Wave 63:
 *   - ONE engine per (Firebase app, demo flag), shared by every caller
 *     (TasksApp, TaskDetailHost, TapCreateTask3D, TaskPinDock). Each
 *     hook call used to build its own engine, so several drains ran at
 *     once and every mount re-ran the stale-row repair.
 *   - Cold-start work (stale `sending` repair, retention prune, orphan
 *     photo prune, first drain) runs ONCE per engine.
 *   - Photo bytes are persisted (`@ff/tasks` taskBlobs) as well as
 *     held in memory, so a reload between compose and send keeps them.
 *     They are deleted when their row is `sent` or `killed`.
 *   - The engine knows when the browser is offline (no attempts are
 *     spent), and `online` revives rows that failed on network errors.
 */

/** In-memory fast path; the durable copy lives in the blob store. */
const blobCache = new Map<string, Blob>();
let blobStoreOverride: TaskBlobStore | null = null;

function blobStore(): TaskBlobStore | null {
  if (blobStoreOverride) return blobStoreOverride;
  try {
    return getTaskBlobStore();
  } catch {
    return null; // no IndexedDB: memory only
  }
}

export function registerBlob(key: string, blob: Blob): void {
  blobCache.set(key, blob);
  const store = blobStore();
  if (store) {
    void store.put(key, blob).catch(() => {
      /* quota / private mode: the memory copy still serves this session */
    });
  }
}

export function releaseBlob(key: string): void {
  blobCache.delete(key);
  const store = blobStore();
  if (store) void store.delete([key]).catch(() => undefined);
}

/** Memory first, then the durable store (after a reload). */
export const taskBlobSource: BlobSource = {
  async get(blobKey) {
    const hit = blobCache.get(blobKey);
    if (hit) return hit;
    const store = blobStore();
    if (!store) return undefined;
    try {
      const blob = await store.get(blobKey);
      if (blob) blobCache.set(blobKey, blob);
      return blob;
    } catch {
      return undefined;
    }
  },
};

/** Drop the photo bytes of a row that no longer needs them. */
export function releaseRowBlobs(row: OutboxRecord): void {
  if (row.state !== "sent" && row.state !== "killed") return;
  const keys = outboxBlobKeys(row);
  if (keys.length === 0) return;
  for (const k of keys) blobCache.delete(k);
  const store = blobStore();
  if (store) void store.delete(keys).catch(() => undefined);
}

/** Orphan photos (a compose never submitted) older than this are pruned. */
export const ORPHAN_BLOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Drafts table port shared by the sheet + the recovery banner. */
export const draftTable = makeDexieDraftTable(localDb.drafts);

const realClock: OutboxClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

function browserOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

// Wave 18 U6/U7 seam: state-transition crumbs (uuid + kind ONLY, spec
// §6 "no IDs of content") through the global telemetry singleton; zero
// cost while telemetry is unset.
function crumb(transition: OutboxTransition): void {
  safe(
    () =>
      getGlobalTelemetry()?.breadcrumb("outbox", transition.state, {
        id: transition.uuid,
        kind: transition.kind,
      }),
    "outbox crumb failed",
  );
}

function createEngine(app: FirebaseApp, isDemo: boolean): OutboxEngine {
  const base = {
    store: makeDexieOutboxStore(localDb.outbox),
    clock: realClock,
    isOnline: browserOnline,
    onStateChange: releaseRowBlobs,
    onTransition: crumb,
  };
  if (isDemo) {
    // Demo (login-free): a REAL OutboxEngine running against the
    // Dexie-backed DemoTaskSource + the same local outbox store. The
    // executor's upload → data-URL and commit → local write keep the
    // same striped (sending) → sent semantics, with 300–800ms latency.
    return new OutboxEngine({ ...base, executor: getDemoTaskSource().executor(taskBlobSource) });
  }
  const storage = getStorage(app);
  const executor = createTaskExecutor(
    getFirestore(app),
    {
      async exists(path) {
        try {
          await getDownloadURL(ref(storage, path));
          return true;
        } catch {
          return false;
        }
      },
      async upload(path, blob) {
        await uploadBytes(ref(storage, path), blob, {
          contentType: blob.type || "application/octet-stream",
        });
      },
    },
    taskBlobSource,
  );
  return new OutboxEngine({ ...base, executor });
}

async function pruneOrphanBlobs(): Promise<void> {
  const store = blobStore();
  if (!store) return;
  try {
    const live = await localDb.outbox.where("state").anyOf(ACTIVE_OUTBOX_STATES).toArray();
    const keep = new Set<string>(live.flatMap((r) => outboxBlobKeys(r)));
    for (const k of blobCache.keys()) keep.add(k); // compose in progress
    await store.pruneOrphans(keep, Date.now() - ORPHAN_BLOB_AGE_MS);
  } catch {
    /* best effort */
  }
}

/** Cold start, once per engine: repair, prune, drain. */
async function startEngine(engine: OutboxEngine): Promise<void> {
  // Re-queue rows a dead tab stranded in `sending` (VDC Bug 1).
  await engine.recoverStale();
  await engine.pruneSent().catch(() => 0);
  void pruneOrphanBlobs();
  await engine.drain();
}

const demoEngines = new Map<string, OutboxEngine>();
const appEngines = new WeakMap<object, OutboxEngine>();
const liveEngines = new Set<OutboxEngine>();
let onlineListener: (() => void) | null = null;

function ensureOnlineListener(): void {
  if (onlineListener || typeof window === "undefined") return;
  onlineListener = () => {
    for (const engine of liveEngines) void engine.reviveNetworkFailed();
  };
  window.addEventListener("online", onlineListener);
}

/** The shared engine for (app, isDemo); created and started once. */
export function getTaskEngine(app: FirebaseApp, isDemo: boolean): OutboxEngine {
  const keyed = !isDemo && app && typeof app === "object";
  const existing = keyed ? appEngines.get(app) : demoEngines.get(String(isDemo));
  if (existing) return existing;
  const engine = createEngine(app, isDemo);
  if (keyed) appEngines.set(app, engine);
  else demoEngines.set(String(isDemo), engine);
  liveEngines.add(engine);
  ensureOnlineListener();
  void startEngine(engine).catch(() => undefined);
  return engine;
}

/** Test-only: forget the shared engines, the listener and the blob cache. */
export function resetTaskEnginesForTests(store: TaskBlobStore | null = null): void {
  demoEngines.clear();
  liveEngines.clear();
  if (onlineListener && typeof window !== "undefined") {
    window.removeEventListener("online", onlineListener);
  }
  onlineListener = null;
  blobCache.clear();
  blobStoreOverride = store;
}

export function useTaskEngine(): OutboxEngine | null {
  const { app, isDemo } = useAuthContext();
  return useMemo(() => getTaskEngine(app, isDemo), [app, isDemo]);
}
