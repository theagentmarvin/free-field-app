// Quick access from a task's location (Models half): when a task's 3D
// location is opened (task thumb / detail card anywhere), restore the
// saved camera and select / highlight the task's elements.
//
// The viewer is persistent (keep-alive), so this never reloads a model:
// it waits for the target building to be the active one and for the
// target model(s) to be loaded, then applies the view once. A task
// created before the camera was stored has no pose: it only frames /
// selects the element.

import { useEffect } from "react";
import type { RefObject } from "react";

import { consumeTaskOpen, restorePinView, useTaskOpenState } from "@ff/tasks-react";
import { useViewerHandle } from "@ff/viewer-tools";
import type { IfcViewerHandle } from "@ff/viewer-react";

const POLL_MS = 400;
const MAX_POLLS = 225; // ~90 s for a cold model load

export function useModelsTaskOpen(
  viewerRef: RefObject<IfcViewerHandle>,
  activeBuildingId: string | null,
): void {
  const { intent } = useTaskOpenState();
  const handle = useViewerHandle(viewerRef);

  useEffect(() => {
    if (!intent || intent.kind !== "models") return;
    if (intent.buildingId && intent.buildingId !== activeBuildingId) return;
    if (!handle) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const apply = (): boolean => {
      const loaded = handle.loadedModelIds;
      const needed = intent.elements.map((e) => e.modelId);
      const ready = needed.length > 0 ? needed.every((id) => loaded.has(id)) : loaded.size > 0;
      if (!ready) return false;
      const taken = consumeTaskOpen("models");
      if (!taken || taken.id !== intent.id) return true;
      restorePinView(handle, {
        taskId: taken.taskId,
        num: 0,
        title: "",
        status: 0,
        pending: false,
        worldPoint: taken.worldPoint ?? [0, 0, 0],
        cameraPose: taken.cameraPose,
        elements: taken.elements,
      });
      return true;
    };

    if (!apply()) {
      let polls = 0;
      const tick = (): void => {
        if (cancelled) return;
        polls += 1;
        if (apply() || polls >= MAX_POLLS) return;
        timer = setTimeout(tick, POLL_MS);
      };
      timer = setTimeout(tick, POLL_MS);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intent, handle, activeBuildingId]);
}
