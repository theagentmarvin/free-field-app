// apps/models/src/PersistentViewerSurface.tsx
//
// Wave 52 — the persistent 3D-viewer surface kernel.
//
// Before wave 52, <ModelsApp> owned the <IfcViewer> ref + the data
// wiring (filter pipeline, selection sync, live IFC query) and only
// <ModelsApp> could host it. Wave 52 moves that ownership here so the
// SAME <IfcViewer> instance can be portaled into whichever route is
// active: the Models viewport on /models, or the Linkview right pane
// on /linkview. The React subtree (and its WebGL canvas) never
// remounts — only the portal target changes, so camera / selection /
// visibility state survives the route switch.
//
// The settings shell's <ViewerKeepAlive> owns the `viewerRef` + the
// `hostNode` (registered by the active route's <ViewerSurfaceHostSlot>)
// and passes them down here.

import { useLiveQuery } from "dexie-react-hooks";
import {
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { db } from "@ff/data/db/database";
import { useProjectId } from "@ff/auth";
import { type IfcViewerHandle } from "@ff/viewer-react";
import { useIfcFiles } from "@ff/data/hooks";

import {
  ViewerToolsProvider,
  useModelsToolFilter,
  useModelsToolStore,
  useViewerExpressIdMaps,
  useViewerSelectionSync,
} from "@ff/viewer-tools";

import { modelsDataSource } from "./modelsDataSource";
import ViewerSurface from "./ViewerSurface";
import { useTaskDetailStore } from "./taskDetailStore";

export interface PersistentViewerSurfaceProps {
  /** The shared <IfcViewer> handle ref (owned by <ViewerKeepAlive>). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** The active route's portal target (null when no host is mounted). */
  hostNode: HTMLElement | null;
  /** True → surface renders its internal <ViewerToolbar> (Models). */
  showViewerToolbar: boolean;
  /** Report whether the surface has ≥1 loaded model (Linkview overlay). */
  onLoadedModelsChange?: (loaded: boolean) => void;
  /**
   * Wave 64 — pause 3D rendering while the surface is covered (e.g. an
   * opaque Documents PDF). Forwarded to `<IfcViewer renderPaused>`;
   * loading and picking state are untouched.
   */
  renderPaused?: boolean;
}

/**
 * Wraps the kernel in <ViewerToolsProvider> — the pipeline hooks below
 * resolve their Dexie data through the injected `modelsDataSource`.
 */
export default function PersistentViewerSurface(
  props: PersistentViewerSurfaceProps,
): JSX.Element {
  return (
    <ViewerToolsProvider dataSource={modelsDataSource}>
      <PersistentViewerSurfaceInner {...props} />
    </ViewerToolsProvider>
  );
}

function PersistentViewerSurfaceInner({
  viewerRef,
  hostNode,
  showViewerToolbar,
  onLoadedModelsChange,
  renderPaused = false,
}: PersistentViewerSurfaceProps): JSX.Element | null {
  // Wave 35 — the active building lives in the SHARED store: the
  // building switcher (module rail) and the Linkview sidebar both
  // write to it, and the persistent surface follows either.
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore(
    (s) => s.setActiveBuildingId,
  );
  const activeStoreyName = useModelsToolStore((s) => s.activeStoreyName);
  const setActiveStoreyName = useModelsToolStore(
    (s) => s.setActiveStoreyName,
  );

  // Wave 52 — the task detail sheet id now lives in a module store so
  // both the TasksPanelBody (Models chrome) and the <TaskDetailHost>
  // (inside this surface) can drive the same single sheet.
  const detailTaskId = useTaskDetailStore((s) => s.detailTaskId);
  const openTask = useTaskDetailStore((s) => s.openTask);
  const closeTask = useTaskDetailStore((s) => s.closeTask);

  // ── Data wiring (moved from <ModelsAppInner>) ────────────────────
  const files = useIfcFiles(activeBuildingId);
  const expressIdMaps = useViewerExpressIdMaps(viewerRef);
  useModelsToolFilter(expressIdMaps, viewerRef);
  useViewerSelectionSync(viewerRef);

  const projectId = useProjectId();

  // A project switch invalidates the active building (it belongs to
  // the previous project). The first resolution keeps whatever the
  // persisted store hydrated.
  const prevProjectRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevProjectRef.current;
    prevProjectRef.current = projectId;
    if (prev !== undefined && prev !== projectId) {
      setActiveBuildingId(null);
    }
  }, [projectId, setActiveBuildingId]);

  // ── Auto-select the first building (moved from <ModelsAppInner>) ─
  // A LIVE query, not a one-shot read: on a first visit the demo seed
  // (or a building created in another tab) writes the building AFTER
  // this surface mounts. The old one-shot read found no buildings,
  // left the store at null and never looked again, so a fresh visit
  // straight to /models showed "No building selected".
  const firstBuildingId = useLiveQuery(async () => {
    if (!projectId) return null;
    const buildings = await db.buildings
      .where("projectId")
      .equals(projectId)
      .toArray();
    const sorted = [...buildings].sort((a, b) => {
      const aTs = (a as { createdAt?: number }).createdAt ?? 0;
      const bTs = (b as { createdAt?: number }).createdAt ?? 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.id.localeCompare(b.id);
    });
    return sorted[0]?.id ?? null;
  }, [projectId]);

  useEffect(() => {
    if (!firstBuildingId) return;
    if (useModelsToolStore.getState().activeBuildingId) return;
    setActiveBuildingId(firstBuildingId);
  }, [firstBuildingId, setActiveBuildingId]);

  // ── Report the "surface loaded" signal to the shell ─────────────
  // `expressIdMaps.modelToExpressIds` is non-empty once the viewer has
  // resolved at least one loaded model's geometry ids — the same signal
  // `useViewerExpressIdMaps` already produces (and the ONLY place that
  // subscribes to the handle's `onLoadedModelsChange`, so no listener
  // clash). Linkview uses this to suppress its left-pane loading overlay.
  const loaded = expressIdMaps.modelToExpressIds.size > 0;
  useEffect(() => {
    onLoadedModelsChange?.(loaded);
  }, [loaded, onLoadedModelsChange]);

  // The slice object is memoized so its reference is stable across
  // renders (same seam the old <Viewer> used).
  const viewerSlice = useMemo(
    () => ({ activeStoreyName, setActiveStoreyName }),
    [activeStoreyName, setActiveStoreyName],
  );

  if (!hostNode || !projectId) return null;

  return createPortal(
    <ViewerSurface
      buildingId={activeBuildingId}
      viewerRef={viewerRef}
      projectId={projectId}
      files={files}
      viewerSlice={viewerSlice}
      activeStoreyName={activeStoreyName}
      detailTaskId={detailTaskId}
      onOpenTask={openTask}
      onCloseTask={closeTask}
      showViewerToolbar={showViewerToolbar}
      renderPaused={renderPaused}
    />,
    hostNode,
  );
}