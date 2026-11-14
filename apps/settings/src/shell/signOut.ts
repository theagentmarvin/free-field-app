// apps/settings/src/shell/signOut.ts
//
// Wave 63 — the rail's "Sign out". Besides ending the Firebase session
// it clears what must not leak to the next user of a shared device:
//   - the remembered project-choice hint (the provider also drops its
//     in-memory current project when the uid goes to null — wave 65),
//   - the email-link sign-in email key,
//   - the IndexedDB tile cache (built model geometry), by deleting the
//     whole `ff-fragments-tile-cache` database.
//
// The tile-cache database may be held open by a fragments worker, in
// which case `deleteDatabase` stays blocked until that connection
// closes. We therefore set a "purge pending" flag first, wait briefly,
// and retry the delete on the next boot (`resumePendingTileCachePurge`)
// until it succeeds. The caller reloads to /sign-in afterwards, which
// tears the workers (and their connections) down.

import { clearProjectChoice } from "./projectChoice";

export const TILE_CACHE_DB_NAME = "ff-fragments-tile-cache";
export const TILE_CACHE_PURGE_PENDING_KEY = "ff-tile-cache-purge-pending";
export const SIGN_IN_EMAIL_KEY = "emailForSignIn";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Delete the tile-cache database. Resolves true once it is gone, false
 * on error or when it is still blocked after `timeoutMs` (the request
 * stays queued and completes when the last connection closes).
 */
export function purgeTileCache(timeoutMs = 1500): Promise<boolean> {
  const idb = globalThis.indexedDB;
  if (!idb) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      const req = idb.deleteDatabase(TILE_CACHE_DB_NAME);
      req.onsuccess = () => {
        try {
          storage()?.removeItem(TILE_CACHE_PURGE_PENDING_KEY);
        } catch {
          /* ignore */
        }
        done(true);
      };
      req.onerror = () => done(false);
    } catch {
      done(false);
    }
  });
}

/** Boot-time retry of a tile-cache purge a previous sign-out left pending. */
export function resumePendingTileCachePurge(): Promise<boolean> | null {
  if (storage()?.getItem(TILE_CACHE_PURGE_PENDING_KEY) !== "1") return null;
  return purgeTileCache();
}

/**
 * Sign out and clear per-user local state. Local cleanup happens even
 * if the Firebase sign-out call fails (the error is re-thrown after).
 */
export async function signOutAndClear(signOut: () => Promise<void>): Promise<void> {
  const s = storage();
  try {
    s?.setItem(TILE_CACHE_PURGE_PENDING_KEY, "1");
    s?.removeItem(SIGN_IN_EMAIL_KEY);
  } catch {
    /* storage unavailable */
  }
  clearProjectChoice();
  try {
    await signOut();
  } finally {
    await purgeTileCache();
  }
}
