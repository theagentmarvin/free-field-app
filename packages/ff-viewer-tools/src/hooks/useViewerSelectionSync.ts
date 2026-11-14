// apps/models/src/hooks/useViewerSelectionSync.ts
//
// Task 21 — bridge between `modelsToolStore.selection` (source of
// truth) and the IfcViewer's `OBCF.Highlighter` (renderer). Every
// time the store changes (user picks an element, drawer × button
// clears, future deep-link activates), the viewer reflects it.
//
// Why a separate hook instead of inlining the effect in
// `ModelsApp`?
//   1. Keeps ModelsApp small and focused on wiring other hooks.
//   2. Makes the bridge unit-testable in isolation
//      (`useViewerSelectionSync.test.tsx`).
//   3. Lets future panels (e.g. a sidebar "selected element"
//      badge) re-import the hook to subscribe to the same store
//      without each owning its own subscription.
//
// Pattern matches `useModelsToolFilter` (the visibility batching
// hook added in Task 19): read store via Zustand selector, run
// a useEffect keyed on the slice + the viewer ref. The viewer
// handle's `selectElement` and `clearSelection` are idempotent
// — repeated calls with the same args are no-ops in practice
// (the Highlighter's internal state matches), so the effect is
// safe to run on every store change.

import { useEffect, useRef, type RefObject } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

import { useModelsToolStore } from "../modelsToolStore";

export function useViewerSelectionSync(
  viewerRef: RefObject<IfcViewerHandle>,
): void {
  const selection = useModelsToolStore((s) => s.selection);
  const hasFiredRef = useRef(false);
  const isSyncingRef = useRef(false);

  useEffect(() => {
    if (isSyncingRef.current) return;
    const handle = viewerRef.current;
    if (!handle) return;
    if (!hasFiredRef.current) {
      hasFiredRef.current = true;
      if (selection === null) return;
    }

    // Check if viewer already matches store. If yes, skip —
    // the Highlighter's autoHighlightOnClick already applied
    // the highlight, and feeding it back would cause an
    // infinite loop (click → highlight → store → sync →
    // highlightByID → onHighlight → store → sync → ...).
    const viewerSel = handle.getSelection();
    if (selection === null) {
      if (viewerSel.size === 0) return;
    } else {
      const set = viewerSel.get(selection.modelId);
      if (set?.has(selection.expressId)) return;
    }

    isSyncingRef.current = true;
    try {
      if (selection === null) {
        handle.clearSelection();
      } else {
        handle.selectElement(selection.modelId, selection.expressId);
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, [selection, viewerRef]);
}