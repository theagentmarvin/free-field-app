// apps/documents/src/hooks/useSheetTasks.ts
//
// The open sheet's task rows + the page it currently shows. Feeds both the
// toolbar's Tasks badge and the Tasks panel body so the two never disagree.
// PdfOverlay has no page-change event, so the current page is re-read on the
// same 250 ms tick the plan marker layer uses.

import { useEffect, useMemo, useState, type RefObject } from "react";

import {
  scopeTasks,
  usePanelTasks,
  type PanelTask,
} from "@ff/tasks-react";
import type { PdfOverlayHandle } from "@ff/viewer-react";

export interface SheetTasks {
  /** Every task of the active building (merged with pending outbox rows). */
  tasks: PanelTask[];
  /** The page the open sheet currently shows (1-based). */
  currentPage: number;
  /** Tasks placed on the current page: what the toolbar badge counts. */
  onPage: PanelTask[];
}

export function useSheetTasks(
  overlayRef: RefObject<PdfOverlayHandle> | null,
  buildingId: string | null,
  enabled: boolean,
): SheetTasks {
  const tasks = usePanelTasks({ buildingId });
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      const page = overlayRef?.current?.getCurrentPage();
      if (typeof page === "number" && page >= 1) {
        setCurrentPage((c) => (c === page ? c : page));
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [overlayRef, enabled]);

  const onPage = useMemo(
    () => scopeTasks(tasks, { scope: "inview", pdfPage: currentPage }),
    [tasks, currentPage],
  );

  return { tasks, currentPage, onPage };
}
