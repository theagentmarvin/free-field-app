// apps/models/src/MainAppChrome.tsx
//
// Wave 52 — Models module UI layout (toolbar nav), refactored for the
// same-instance viewer. The 3D surface itself moved to the persistent
// kernel; this component now owns ONLY the chrome: the viewport slot
// the surface portals into, the floating nav toolbar, and the one
// floating nav panel.

import { useCallback, type CSSProperties, type RefObject } from "react";

import { useModelsToolStoreHydration } from "./useModelsToolStoreHydration";
import { useModelsToolStore } from "@ff/viewer-tools";
import { useTaskDetailStore } from "./taskDetailStore";
import { useModelsTaskOpen } from "./useModelsTaskOpen";
import { ViewerSurfaceHostSlot } from "./viewerSurfaceHost";
import NavToolbar from "./NavToolbar";
import NavPanel from "./NavPanel";

import type { IfcViewerHandle } from "@ff/viewer-react";

export interface MainAppChromeProps {
  viewerRef: RefObject<IfcViewerHandle>;
  registerHost: (node: HTMLElement | null) => void;
}

export default function MainAppChrome({
  viewerRef,
  registerHost,
}: MainAppChromeProps): JSX.Element {
  useModelsToolStoreHydration();

  // Wave 52 — the building id lives in the shared store (the kernel
  // auto-selects it; the module rail can switch it).
  const buildingId = useModelsToolStore((s) => s.activeBuildingId);
  // Task quick access: restore a task's saved camera + select its elements.
  useModelsTaskOpen(viewerRef, buildingId);

  // Wave 50/52 — the task detail sheet id lives in a module store now
  // (the <TaskDetailHost> renders inside the persistent surface, a
  // different React tree). NavPanel's task menu opens it via `openTask`.
  const openTask = useTaskDetailStore((s) => s.openTask);
  const onOpenTask = useCallback(
    (taskId: string): void => {
      openTask(taskId);
    },
    [openTask],
  );

  const shellStyle: CSSProperties = {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    width: "100%",
    overflow: "hidden",
  };

  // The canvas owns the whole area: no header, no sidebar.
  const viewerPaneStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    height: "100%",
    display: "flex",
    position: "relative",
  };

  return (
    <div style={shellStyle} className="ff-app-shell">
      <div style={viewerPaneStyle}>
        {/* The persistent surface portals into this slot. */}
        <ViewerSurfaceHostSlot registerHost={registerHost} testId="models-viewer" />
      </div>
      <NavToolbar />
      <NavPanel
        buildingId={buildingId}
        viewerRef={viewerRef}
        onOpenTask={onOpenTask}
      />
    </div>
  );
}