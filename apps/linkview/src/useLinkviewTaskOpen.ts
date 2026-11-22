// apps/linkview/src/useLinkviewTaskOpen.ts
//
// Quick access for a task created in LinkView (both sides stored): open
// the sheet at the task's page, zoom to the pin and highlight it, AND
// restore the 3D camera + select the element(s). It is the Documents hook
// and the Models hook applied to the two panes of one screen, driven by
// ONE intent (kind "linkview") so each half starts when its own surface
// is ready, and a half whose target is gone is simply absent.
//
//   1. take the intent once the target building is the active one; open
//      the sheet version (the app's own PDF switch) and highlight the pin;
//   2. plan half: once that version is the open one and rendered, go to
//      the page and zoom to the pin;
//   3. 3D half: once the camera settled (LinkView seeds its first-person
//      camera when a calibrated sheet opens - restoring before that would
//      be overwritten) and the target model(s) are loaded, restore the
//      saved viewpoint and select the elements.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { consumeTaskOpen, restorePinView, setTaskHighlight, useTaskOpenState } from "@ff/tasks-react";
import { useViewerHandle } from "@ff/viewer-tools";
import type { IfcViewerHandle, PdfOverlayHandle } from "@ff/viewer-react";

const POLL_MS = 250;
const MAX_POLLS = 120; // ~30 s for a cold PDF render
const MODEL_POLL_MS = 400;
const MODEL_MAX_POLLS = 225; // ~90 s for a cold model load
const SETTLE_MS = 500; // after goToPage re-renders the page
const HIGHLIGHT_MS = 10000;
const PIN_ZOOM = 1.6;
const SETTLE_FALLBACK_MS = 6000; // never wait forever on the camera seed

interface PlanFocus {
  versionId: string;
  page: number;
  uv: [number, number] | null;
}
interface ViewFocus {
  taskId: string;
  elements: { modelId: string; expressId: number }[];
  worldPoint: [number, number, number] | null;
  cameraPose: NonNullable<Parameters<typeof restorePinView>[1]["cameraPose"]> | null;
}

export function useLinkviewTaskOpen(opts: {
  overlayRef: RefObject<PdfOverlayHandle> | null;
  viewerRef: RefObject<IfcViewerHandle>;
  activeBuildingId: string | null;
  activePdfVersionId: string | null;
  openVersion: (versionId: string) => void;
  /** false while LinkView is still (re)seeding the 3D camera for the open sheet */
  cameraSettled: boolean;
}): void {
  const { overlayRef, viewerRef, activeBuildingId, activePdfVersionId, cameraSettled } = opts;
  const { intent } = useTaskOpenState();
  const handle = useViewerHandle(viewerRef);
  const [plan, setPlan] = useState<PlanFocus | null>(null);
  const [view, setView] = useState<ViewFocus | null>(null);
  const [forced, setForced] = useState(false);
  const openRef = useRef(opts.openVersion);
  openRef.current = opts.openVersion;
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const taskIdRef = useRef<string | null>(null);
  // (Re)start the pin highlight's lifetime. A cold sheet can take longer to
  // render than the highlight lasts, so it restarts once the pin is in view.
  const armHighlight = (taskId: string): void => {
    setTaskHighlight(taskId);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setTaskHighlight(null), HIGHLIGHT_MS);
  };

  // 1. take the intent (building must be the target's)
  useEffect(() => {
    if (!intent || intent.kind !== "linkview") return;
    if (intent.buildingId && intent.buildingId !== activeBuildingId) return;
    const taken = consumeTaskOpen("linkview");
    if (!taken) return;
    if (taken.documents) {
      openRef.current(taken.documents.versionId);
      setPlan({ versionId: taken.documents.versionId, page: taken.documents.page, uv: taken.documents.uv });
    } else {
      setPlan(null);
    }
    setForced(false);
    setView(
      taken.models
        ? {
            taskId: taken.taskId,
            elements: taken.models.elements,
            worldPoint: taken.models.worldPoint,
            cameraPose: taken.models.cameraPose,
          }
        : null,
    );
    taskIdRef.current = taken.taskId;
    // not cleaned up with the effect: consuming the intent re-runs it
    armHighlight(taken.taskId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent, activeBuildingId]);

  // 2. plan half: page + zoom to the pin once the version is open and rendered
  useEffect(() => {
    if (!plan || activePdfVersionId !== plan.versionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const tick = (): void => {
      if (cancelled) return;
      const o = overlayRef?.current;
      if (o && o.getAnnotationLayer() && o.getDocument()) {
        if (o.getCurrentPage() !== plan.page) o.goToPage(plan.page);
        timer = setTimeout(() => {
          if (cancelled) return;
          if (plan.uv) o.focusUv(plan.uv, PIN_ZOOM);
          if (taskIdRef.current) armHighlight(taskIdRef.current);
          setPlan(null);
        }, SETTLE_MS);
        return;
      }
      polls += 1;
      if (polls >= MAX_POLLS) {
        setPlan(null);
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [plan, activePdfVersionId, overlayRef]);

  // A sheet that never reports a seeded camera (no calibration) must not
  // block the 3D half forever.
  useEffect(() => {
    if (!view) return;
    const t = setTimeout(() => setForced(true), SETTLE_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [view]);

  // 3. 3D half: restore the viewpoint + selection once models are in and
  //    the camera is no longer being seeded for the sheet
  useEffect(() => {
    if (!view || !handle || !(cameraSettled || forced)) return;
    // The plan half changes the open sheet first; wait for it so the seed does not win.
    if (plan && activePdfVersionId !== plan.versionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const apply = (): boolean => {
      const loaded = handle.loadedModelIds;
      const needed = view.elements.map((e) => e.modelId);
      const ready = needed.length > 0 ? needed.every((id) => loaded.has(id)) : loaded.size > 0;
      if (!ready) return false;
      restorePinView(handle, {
        taskId: view.taskId,
        num: 0,
        title: "",
        status: 0,
        pending: false,
        worldPoint: view.worldPoint ?? [0, 0, 0],
        cameraPose: view.cameraPose,
        elements: view.elements,
      });
      setView(null);
      return true;
    };
    if (!apply()) {
      const tick = (): void => {
        if (cancelled) return;
        polls += 1;
        if (apply() || polls >= MODEL_MAX_POLLS) {
          if (polls >= MODEL_MAX_POLLS) setView(null);
          return;
        }
        timer = setTimeout(tick, MODEL_POLL_MS);
      };
      timer = setTimeout(tick, MODEL_POLL_MS);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [view, handle, cameraSettled, forced, plan, activePdfVersionId]);
}
