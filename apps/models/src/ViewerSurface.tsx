// apps/models/src/ViewerSurface.tsx
//
// Wave 52 — the hostable 3D-viewer surface extracted from <Viewer>.
//
// <Viewer> used to own every concern of the Models viewport: the
// ifc-files live query, the viewerSlice, the registerFragments seam,
// and the DOM (IfcViewer + overlays + toolbar + context toolbar +
// task detail host). Wave 52 splits that in two so the SAME surface
// can be hosted by BOTH the Models route and the Linkview route
// (one IfcViewer instance, never two; the WebGL canvas survives the
// React-portal reparenting).
//
// This component is the PURE surface: it receives its data inputs as
// props (`files`, `viewerSlice`, `activeStoreyName`) and renders the
// viewport + every floating overlay. The data wiring (useIfcFiles,
// the filter/selection pipeline) lives in the host's kernel — see
// apps/settings/src/shell/ViewerKeepAlive.tsx + the
// <PersistentViewerSurface> in this package.
//
// `<Viewer>` (Viewer.tsx) is now a thin host that computes the data
// inputs and renders this surface, so the Models view behaves
// identically to before.

import { useRef, type CSSProperties, type RefObject } from "react";

import {
  IfcViewer,
  type IfcViewerHandle,
  type IfcFileListItem,
} from "@ff/viewer-react";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import {
  useIfcPipeline,
  getStoreysForBuilding,
} from "@ff/data/hooks";

import { useManualVisibilityStore } from "@ff/viewer-tools";
import { hideBimElements } from "./hideBimElements";
import ViewerToolbar from "./ViewerToolbar";
import SelectionContextToolbar from "./SelectionContextToolbar";
import {
  TapCreateTask3D,
  TaskCalloutLayer3D,
  TaskDetailHost,
  restorePinView,
  useTaskPhotoResolver,
} from "@ff/tasks-react";

export interface ViewerSurfaceProps {
  /** Active building id. Null when no building has been auto-selected yet. */
  buildingId: string | null;
  /** Ref bound to the IfcViewer, created by the surface's host kernel. */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Project the saved-viewpoints rows are scoped to. */
  projectId: string;
  /** Live IFC files for `buildingId` (the data input). */
  files: IfcFileListItem[];
  /** The store slice mirror (`activeStoreyName` + `setActiveStoreyName`). */
  viewerSlice: {
    activeStoreyName: string | null;
    setActiveStoreyName: (name: string | null) => void;
  };
  /** Active storey name (drives the 3D tap-to-create marker). */
  activeStoreyName: string | null;
  /** The task detail sheet id to show (lifted to the host kernel). */
  detailTaskId?: string | null;
  /** Open the task detail sheet for a task id (pin tap + task menu). */
  onOpenTask?: (taskId: string) => void;
  /** Close the task detail sheet. */
  onCloseTask?: () => void;
  /**
   * Wave 52 — render the internal <ViewerToolbar> (Measure + Save view)
   * inside the surface. Default `true`.
   *
   * The Linkview route replaces this internal toolbar with its own
   * <LinkviewToolbar> (mode toggle + measure + save view), so it
   * passes `false` and renders its toolbar as a sibling overlay.
   */
  showViewerToolbar?: boolean;
  /**
   * Wave 64 — pause rendering while the surface is covered (forwarded
   * to `<IfcViewer renderPaused>`). Default `false`.
   */
  renderPaused?: boolean;
}

const wrapperStyle: CSSProperties = {
  position: "relative",
  flex: 1,
  height: "100%",
  background: "var(--ff-bg-app)",
  overflow: "hidden",
};

const emptyStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--ff-text-secondary)",
  fontSize: 13,
  textAlign: "center",
  padding: 24,
  lineHeight: 1.5,
};

/**
 * The hostable 3D viewport surface (see the file header).
 *
 * Pure surface — no live queries, no store reads: everything it needs
 * (building, files, slice) arrives as props. The only internal seams
 * that remain are the FragmentsManager registration and the task photo
 * resolver, both of which are cheap, idempotent subscriptions.
 */
export default function ViewerSurface({
  buildingId,
  viewerRef,
  projectId,
  files,
  viewerSlice,
  activeStoreyName,
  detailTaskId = null,
  onOpenTask,
  onCloseTask,
  showViewerToolbar = true,
  renderPaused = false,
}: ViewerSurfaceProps): JSX.Element {
  // Settings's pipeline hook owns FragmentsManager registration. The
  // host kernel doesn't upload IFCs (Settings does that), so `loadIfc`
  // and `isLoading` are unused here; we just need `registerFragments`
  // to plumb the IfcViewer's FragmentsModels instance into the pipeline.
  const { registerFragments } = useIfcPipeline();

  // Pin click / task-menu row open the detail sheet via `onOpenTask`.
  // The layer's own click handler has already restored the author's
  // pose by then.
  const photoResolver = useTaskPhotoResolver();

  // Wave 47 — the right-click context toolbar listens for `contextmenu`
  // on the `position: relative` wrapper and converts client coords to
  // wrapper-relative CSS px, so it needs a handle on the wrapper node.
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  if (!buildingId) {
    return (
      <div style={wrapperStyle} data-testid="models-viewer">
        <div style={emptyStyle}>
          No building selected.
          <br />
          Create one in Settings to start viewing models here.
        </div>
      </div>
    );
  }

  // buildingId is set. The IfcViewer handles an empty `files` array
  // internally (it just renders the empty world) — we render it
  // whenever a building is selected so Dexie's live-query transition
  // doesn't unmount it.
  return (
    <div ref={wrapperRef} style={wrapperStyle} data-testid="models-viewer">
      <IfcViewer
        ref={viewerRef}
        projectId={projectId}
        activeBuildingId={buildingId}
        files={files}
        getFragBlob={getFragBlob}
        registerFragments={registerFragments}
        getStoreysForBuilding={getStoreysForBuilding}
        viewerSlice={viewerSlice}
        renderPaused={renderPaused}
      />
      {/* Task pins. See the old <Viewer> file header for the
          worldToScreen-canvas-relative rationale. */}
      <TaskCalloutLayer3D
        getHandle={() => viewerRef.current}
        buildingId={buildingId}
        onOpenTask={(pin) => onOpenTask?.(pin.taskId)}
      />
      <TapCreateTask3D
        getHandle={() => viewerRef.current}
        storeyName={activeStoreyName}
        buildingId={buildingId}
        onComposeOpen={() => onCloseTask?.()}
        detailTaskId={detailTaskId}
      />
      {/* Wave 12 / wave 50 — bottom viewer toolbar (Measure + Save view).
          The Linkview route suppresses this and mounts its own
          <LinkviewToolbar> (which adds the Split/Overlap toggle). */}
      {showViewerToolbar && (
        <ViewerToolbar
          getHandle={() => viewerRef.current}
          projectId={projectId}
        />
      )}
      {/* Wave 47 — right-click selection context toolbar. */}
      <SelectionContextToolbar
        getHandle={() => viewerRef.current}
        wrapperRef={wrapperRef}
      />
      {detailTaskId && (
        <TaskDetailHost
          taskId={detailTaskId}
          onClose={() => onCloseTask?.()}
          resolvePhotoUrl={photoResolver}
          onShowIn3D={(bim) => {
            const h = viewerRef.current;
            if (!h) return;
            restorePinView(h, {
              taskId: detailTaskId,
              num: 0,
              title: "",
              status: 0,
              pending: false,
              worldPoint: bim.worldPoint ?? [0, 0, 0],
              cameraPose: bim.cameraPose ?? null,
              elements: bim.elements ?? [],
            });
          }}
          onHideInstance={(bim) => {
            // Wave 50 — durable manual hide (wave-48 overlay).
            hideBimElements(bim.elements, (modelId, ids) =>
              useManualVisibilityStore.getState().hideIds(modelId, ids),
            );
          }}
        />
      )}
    </div>
  );
}