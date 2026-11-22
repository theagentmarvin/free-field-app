// apps/settings/src/shell/useLegacyProjectRekey.ts
//
// Wave 65 — fire the one-time local re-key (@ff/data
// `rekeyLegacyProjectData`) the first time a signed-in user lands in a
// REAL project on this device. Pre-Phase-1 rows keyed to
// "default-project" move to that project; the function itself is
// idempotent (marker per uid + project) and skips demo mode.
//
// Pass `uid = null` (signed out / demo) or `projectId = null` to do
// nothing. See docs/SPEC-PHASE-1.md §7.

import { useEffect, useState } from "react";

import { isDemoAuth } from "@ff/auth";
import { rekeyLegacyProjectData } from "@ff/data/db/legacyProjectRekey";

/**
 * Returns `ready`: false until the re-key for (uid, projectId) has settled
 * (success OR failure), so Phase 1c sync arms only after local rows carry
 * the real project id. Nothing to do (signed out / demo) counts as ready.
 */
export function useLegacyProjectRekey(
  uid: string | null,
  projectId: string | null | undefined,
): boolean {
  const key = uid && projectId ? `${uid}:${projectId}` : null;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (!uid || !projectId) return;
    rekeyLegacyProjectData({ uid, projectId, isDemo: isDemoAuth() })
      .finally(() => setSettledKey(`${uid}:${projectId}`))
      .then((result) => {
        if (result.status === "rekeyed") {
          // eslint-disable-next-line no-console
          console.info("[ff] moved local data to the current project", result.moved);
        }
      })
      .catch((err: unknown) => {
        // Never blocks the app: the rows simply stay where they were and
        // the next load retries (no marker is written on failure).
        // eslint-disable-next-line no-console
        console.error("[ff] local data re-key failed", err);
      });
  }, [uid, projectId]);
  return key === null || settledKey === key;
}
