// apps/models/src/Viewer.tsx
//
// Wave 52 — thin host around the extracted <ViewerSurface>.
//
// The Models module's 3D viewport still behaves EXACTLY as before:
// this component computes the data inputs (the IFC files live query,
// the viewerSlice) and delegates the DOM surface to <ViewerSurface>
// (same wrapper + IfcViewer + overlays + toolbar + context toolbar +
// task detail host). It exists so existing consumers (the Models view
// and its regression tests) can keep using <Viewer> unchanged while
// the persistent wire-up uses <ViewerSurface> directly.

import { useMemo, type RefObject } from "react";

import { useProjectId } from "@ff/auth";
import { type IfcViewerHandle } from "@ff/viewer-react";
import { useIfcFiles } from "@ff/data/hooks";

import { useModelsToolStore } from "@ff/viewer-tools";

import ViewerSurface from "./ViewerSurface";

export interface ViewerProps {
  /** Active building id. Null when no building has been auto-selected yet. */
  buildingId: string | null;
  /** Ref bound to the IfcViewer; lifted from <ModelsApp> so the same ref
   * is used by both the <IfcViewer ref={...}> mount and any
   * <ViewerHandleProvider> in the tree. */
  viewerRef: RefObject<IfcViewerHandle>;
  /** The task detail sheet id to show. Null = closed. */
  detailTaskId?: string | null;
  /** Open the task detail sheet for a task id (pin tap + task menu). */
  onOpenTask?: (taskId: string) => void;
  /** Close the task detail sheet. */
  onCloseTask?: () => void;
}

/**
 * Models module's 3D viewport (thin host — see the file header).
 * Reads IFCs from the same Dexie Settings writes to.
 */
export default function Viewer({
  buildingId,
  viewerRef,
  detailTaskId = null,
  onOpenTask,
  onCloseTask,
}: ViewerProps): JSX.Element | null {
  const projectId = useProjectId();
  // Reactive live query: Settings's `useIfcFiles` reads the same Dexie
  // tables. When Settings uploads a new IFC version, the live query
  // ticks here and the viewer re-mounts the new model.
  const files = useIfcFiles(buildingId);

  // viewerSlice — read from the Models-local store. Keeps the IfcViewer
  // decoupled from any specific store.
  const activeStoreyName = useModelsToolStore((s) => s.activeStoreyName);
  const setActiveStoreyName = useModelsToolStore(
    (s) => s.setActiveStoreyName,
  );

  // Memoize the slice object so its reference is stable across renders.
  const viewerSlice = useMemo(
    () => ({ activeStoreyName, setActiveStoreyName }),
    [activeStoreyName, setActiveStoreyName],
  );

  // No active project → nothing to show (reads are project-scoped).
  if (!projectId) return null;

  return (
    <ViewerSurface
      buildingId={buildingId}
      viewerRef={viewerRef}
      projectId={projectId}
      files={files}
      viewerSlice={viewerSlice}
      activeStoreyName={activeStoreyName}
      detailTaskId={detailTaskId}
      onOpenTask={onOpenTask}
      onCloseTask={onCloseTask}
    />
  );
}