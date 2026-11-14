import { useEffect, useRef, useState } from "react";

/**
 * Storage-path → download-URL resolution for list-row photo thumbs
 * (VDC 2026-11-02, Wave 1A).
 *
 * The task doc only carries the Storage PATH (`photos[].storagePath`);
 * the bytes live in Storage. The list panel shows a 24px thumb from
 * the FIRST photo of a row, so the resolution must be cheap: one
 * module-level cache is shared by every row, so fifty rows pointing
 * at the same photo cost ONE network call.
 *
 * Failure policy: a rejected or null resolution is cached as `null`
 * and the row simply renders NO thumb — a photo never blocks the list
 * and never shows an error state.
 */

/** Host-supplied resolver: Storage path → download URL (or null). */
export type PhotoUrlResolver = (storagePath: string) => Promise<string | null>;

/** Cache ceiling — FIFO eviction past this point. */
export const PHOTO_URL_CACHE_LIMIT = 250;

/** storagePath → in-flight/settled resolution. */
const cache = new Map<string, Promise<string | null>>();

/** Drop every cached resolution (tests + sign-out/project switch). */
export function clearPhotoUrlCache(): void {
  cache.clear();
}

/** Cached resolve — the same path always yields the SAME promise, so
 *  N rows with one photo trigger exactly one lookup. */
export function resolvePhotoUrlCached(
  resolve: PhotoUrlResolver,
  storagePath: string
): Promise<string | null> {
  const hit = cache.get(storagePath);
  if (hit) return hit;
  const promise = Promise.resolve()
    .then(() => resolve(storagePath))
    .then((url) => (typeof url === "string" && url.length > 0 ? url : null))
    .catch(() => null); // a failed photo is "no thumb", never an error
  cache.set(storagePath, promise);
  // A miss must not be remembered: a just-created task's photo is not in the
  // store until its upload lands, and caching null left the thumb blank until
  // a full reload. Hits stay cached; misses are retried on the next lookup.
  void promise.then((url) => {
    if (url === null && cache.get(storagePath) === promise) cache.delete(storagePath);
  });
  if (cache.size > PHOTO_URL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return promise;
}

/**
 * Hook form: resolve one path for one row.
 *
 * Returns the URL, or null while it is still resolving / when it
 * failed. The previous photo's URL is never shown for a new path.
 */
export function usePhotoUrl(
  resolve: PhotoUrlResolver | undefined,
  storagePath: string | null | undefined
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const pathRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const path = storagePath ?? null;
    if (path !== pathRef.current) {
      pathRef.current = path;
      setUrl(null); // a new photo starts blank — never the previous one
    }
    if (!resolve || !path) return () => {
      alive = false;
    };
    void resolvePhotoUrlCached(resolve, path).then((resolved) => {
      if (!alive) return;
      setUrl((prev) => (prev === resolved ? prev : resolved));
    });
    return () => {
      alive = false;
    };
  }, [resolve, storagePath]);

  return url;
}
