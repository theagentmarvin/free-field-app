import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import type { FirebaseApp } from 'firebase/app';

/**
 * D6 (task-39): the cloud-first plan's "no IndexedDB mirror" only
 * works if Firestore's own offline cache is actually on. It was
 * never configured anywhere in the repo — every surface used bare
 * `getFirestore(app)` (memory-only default).
 *
 * Call this at app bootstrap (AuthProvider) BEFORE any consumer;
 * after this, every later `getFirestore(app)` returns the SAME
 * instance, so existing call sites keep working and get the cache.
 */
let instance: Firestore | null = null;

export function initFirestore(app: FirebaseApp): Firestore {
  if (instance) return instance;
  try {
    // Multi-tab manager: every open FreeField tab shares the one
    // IndexedDB cache. The default single-tab manager gives the cache
    // to the first tab only; the others silently ran memory-only.
    instance = initializeFirestore(app, {
      localCache: persistentLocalCache({
        tabManager: persistentMultipleTabManager(),
      }),
    });
  } catch (err) {
    // Throws if a bare getFirestore() raced us to first contact (or
    // initializeFirestore already ran with other settings) — fall back
    // to the existing instance rather than crash boot, but say so: that
    // instance may have NO offline cache.
    // eslint-disable-next-line no-console
    console.warn(
      '[ff-firestore] persistent multi-tab cache not enabled; using the existing Firestore instance',
      err,
    );
    instance = getFirestore(app);
  }
  return instance;
}

/** Test-only: drop the memoized instance between suites. */
export function __resetFirestoreForTests(): void {
  instance = null;
}
