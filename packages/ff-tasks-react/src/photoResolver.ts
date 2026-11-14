import { useMemo } from "react";

import { useAuthContext } from "@ff/auth";

import type { PhotoUrlResolver } from "./usePhotoUrl";
import { makeTaskPhotoResolver } from "./tasksSource";

/**
 * Host-side Storage resolver for the list-row photo thumbs
 * (VDC 2026-11-02, Wave 1A).
 *
 * Cloud: `getStorage(app)` returns the same Storage instance the outbox
 * engine uploads through — one bucket, one config. Demo: the resolver
 * reads the stored photo DATA URL from the local demo store, so photo
 * uploads → list/table thumbs → lightbox → print all work offline.
 */
export function useTaskPhotoResolver(): PhotoUrlResolver | undefined {
  const { app, isDemo } = useAuthContext();
  return useMemo(() => makeTaskPhotoResolver(app, isDemo), [app, isDemo]);
}