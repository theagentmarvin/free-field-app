// Quick access from a task's location (Documents half): open the task's
// sheet, go to its page, zoom to the pin and highlight it.
//
// Consumes the pending intent once the target building is active, asks
// the app to open the sheet version, and (when that version is the open
// one and the overlay is ready) applies page + zoom. The highlight is
// cleared after a few seconds.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { consumeTaskOpen, setTaskHighlight, useTaskOpenState } from "@ff/tasks-react";
import type { PdfOverlayHandle } from "@ff/viewer-react";

const POLL_MS = 250;
const MAX_POLLS = 120; // ~30 s for a cold PDF render
const SETTLE_MS = 500; // after goToPage re-renders the page
const HIGHLIGHT_MS = 10000;
const PIN_ZOOM = 1.6;

interface FocusTarget {
  versionId: string;
  page: number;
  uv: [number, number] | null;
}

export function useDocumentsTaskOpen(
  overlayRef: RefObject<PdfOverlayHandle> | null,
  activeBuildingId: string | null,
  activePdfVersionId: string | null,
  openVersion: (versionId: string) => void,
): void {
  const { intent } = useTaskOpenState();
  const [focus, setFocus] = useState<FocusTarget | null>(null);
  const openRef = useRef(openVersion);
  openRef.current = openVersion;
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 1. take the intent (building must be the target's) and open the sheet
  useEffect(() => {
    if (!intent || intent.kind !== "documents") return;
    if (intent.buildingId && intent.buildingId !== activeBuildingId) return;
    const taken = consumeTaskOpen("documents");
    if (!taken) return;
    openRef.current(taken.versionId);
    setFocus({ versionId: taken.versionId, page: taken.page, uv: taken.uv });
    setTaskHighlight(taken.taskId);
    // not cleaned up with the effect: consuming the intent re-runs it
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setTaskHighlight(null), HIGHLIGHT_MS);
  }, [intent, activeBuildingId]);

  // 2. once that version is open and rendered: page + zoom to the pin
  useEffect(() => {
    if (!focus || activePdfVersionId !== focus.versionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = (): void => {
      if (cancelled) return;
      const o = overlayRef?.current;
      if (o && o.getAnnotationLayer() && o.getDocument()) {
        if (o.getCurrentPage() !== focus.page) o.goToPage(focus.page);
        timer = setTimeout(() => {
          if (cancelled) return;
          if (focus.uv) o.focusUv(focus.uv, PIN_ZOOM);
          setFocus(null);
        }, SETTLE_MS);
        return;
      }
      polls += 1;
      if (polls >= MAX_POLLS) {
        setFocus(null);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [focus, activePdfVersionId, overlayRef]);
}
