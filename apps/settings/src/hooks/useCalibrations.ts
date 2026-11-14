// src/hooks/useCalibrations.ts
//
// Reactive Dexie live-query for the v4 `calibrations` table. The
// Mapped sub-tab in PdfSidebarBlock is the main consumer. Returns
// pre-indexed Maps so renderers can avoid the N*log(N) sort on
// every render.
//
// See docs/TASK-12a-CALIBRATION-WIZARD.md "Data layer — Live
// query hook" for the contract.

import { useLiveQuery } from "dexie-react-hooks";

import { db } from "@ff/data/db/database";
import type { CalibrationRecord } from "@ff/types";

export interface UseCalibrationsForProjectResult {
  /** Every calibration row for the project (unsorted). */
  calibrations: CalibrationRecord[];
  /** Grouped by pdfFileId for the Mapped sub-tab's file rows. */
  byPdfFileId: Map<string, CalibrationRecord[]>;
  /** Grouped by storeyName for any "per-level" view (Mvp doesn't
   *  use this directly; it's here for the future "calibrate every
   *  PDF to this level" UX). */
  byStoreyName: Map<string, CalibrationRecord[]>;
  /** True while Dexie is still hydrating. The renderer's empty
   *  state should NOT show until isLoading flips false. */
  isLoading: boolean;
}

/**
 * Subscribe to all CalibrationRecord rows for a project. Returns
 * empty arrays/maps while the projectId is null. The Maps are
 * rebuilt on every change (cheap — calibrations per project is
 * bounded by fileCount × storeyCount, which is small in practice).
 */
export function useCalibrationsForProject(
  projectId: string | null,
): UseCalibrationsForProjectResult {
  // useLiveQuery returns `undefined` while the first query is in
  // flight, then the actual value. We surface that to the caller
  // as `isLoading` so renderers can avoid the "empty state" flash.
  // Initial value used both for the loading state (before the
  // first query resolves) and for the "no project selected" /
  // "empty project" states. We return this rather than
  // undefined so consumers can render without a null check.
  const initial: UseCalibrationsForProjectResult = {
    calibrations: [],
    byPdfFileId: new Map(),
    byStoreyName: new Map(),
    isLoading: true,
  };

  const data = useLiveQuery<UseCalibrationsForProjectResult, UseCalibrationsForProjectResult>(
    async () => {
      if (!projectId) {
        return {
          calibrations: [],
          byPdfFileId: new Map(),
          byStoreyName: new Map(),
          isLoading: false,
        };
      }
      const rows = await db.calibrations
        .where("projectId")
        .equals(projectId)
        .toArray();

      const byPdfFileId = new Map<string, CalibrationRecord[]>();
      const byStoreyName = new Map<string, CalibrationRecord[]>();
      for (const r of rows) {
        const pdfList = byPdfFileId.get(r.pdfFileId) ?? [];
        pdfList.push(r);
        byPdfFileId.set(r.pdfFileId, pdfList);

        const storeyList = byStoreyName.get(r.storeyName) ?? [];
        storeyList.push(r);
        byStoreyName.set(r.storeyName, storeyList);
      }
      // Stable order inside each bucket: by createdAt ascending
      // so the Mapped sub-tab shows calibrations in the order
      // they were created (oldest first). New mappings append
      // at the end, which matches the "history" expectation.
      for (const list of byPdfFileId.values()) {
        list.sort((a, b) => a.createdAt - b.createdAt);
      }
      for (const list of byStoreyName.values()) {
        list.sort((a, b) => a.createdAt - b.createdAt);
      }
      return {
        calibrations: rows,
        byPdfFileId,
        byStoreyName,
        isLoading: false,
      };
    },
    [projectId],
    // The 3-arg overload's third arg is the "default" returned
    // before the first query resolves. We use the loading-state
    // shape so consumers can render a "Loading…" hint instead
    // of a (false) empty state.
    initial,
  );

  // useLiveQuery's overload returns `T | TDefault` (never
  // undefined when a default is provided). Cast for the
  // consumer's type clarity.
  return data as UseCalibrationsForProjectResult;
}
