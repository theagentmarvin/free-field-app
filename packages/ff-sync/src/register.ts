import { setBlobMissHandler } from "@ff/data/db/tables/blobMiss";

import type { SyncEngine } from "./engine";

/**
 * Web: make `getFragBlob` / `getPdfBlob` download a missing blob from Storage
 * on first open (spec Q7: lazy fetch). Returns an unregister function.
 */
export function registerBlobMissHandler(engine: SyncEngine): () => void {
  const prev = setBlobMissHandler((kind, key) => engine.fetchBlobByKey(kind, key));
  return () => {
    setBlobMissHandler(prev);
  };
}
