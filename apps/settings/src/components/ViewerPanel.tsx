// src/components/ViewerPanel.tsx
//
// Right-panel host. Renders the 3D viewer by default, the PDF
// canvas when `activePdfVersionId` is set in the viewer store.
// The two are mutually exclusive — exactly one is mounted at any
// time, so we don't pay both render costs.
//
// When the active building has no IFCs and no PDF is open, the
// <EmptyViewerDropzone> shows the upload prompt (with file
// accept=".ifc,application/x-step"). The PDF block has its own
// upload trigger (the `+` icon in its sub-tab bar), so we don't
// duplicate it here.
//
// Task 11 (PDF Canvas) update: the swap from 3D → PDF happens
// via the `useViewerStore.activePdfVersionId` field. <PdfOverlay>
// is unmounted as soon as the field goes back to null (or the
// version id changes — the React key below enforces that).

import { ReactNode, Suspense, lazy, type RefObject, useCallback, useMemo, useState } from "react";

import { IfcViewer, type IfcViewerHandle } from "@ff/viewer-react";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import { PdfOverlay } from "@ff/viewer-react";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { useIfcFiles } from "@ff/data/hooks";
import { useIfcPipeline, getStoreysForBuilding } from "@ff/data/hooks";
import { useViewerStore } from "@store/useViewerStore";

// Wave 56-fix — the Models module's filter tools live in the mapping
// view (the settings route's viewer), because THAT is where the maintainer
// maps PDFs to levels and needs to turn models on/off. Same pattern
// as apps/models' PersistentViewerSurface: ViewerToolsProvider +
// modelsDataSource, and the filter/visibility hooks applied to THIS
// viewer instance.
import { modelsDataSource } from "../../../../apps/models/src/modelsDataSource";
import {
  FrostedNavSlot,
  FrostedNavToolbar,
  type FrostedNavButton,
} from "../../../../packages/ff-viewer-tools/src/components/FrostedNav";
import CustomFiltersPanel from "../../../../packages/ff-viewer-tools/src/components/CustomFiltersPanel";
import ModelsLevelsPanel from "../../../../packages/ff-viewer-tools/src/components/ModelsLevelsPanel";
import { ViewerToolsProvider } from "../../../../packages/ff-viewer-tools/src/dataSource";
import { useIsMobile } from "../../../../packages/ff-viewer-tools/src/hooks/useIsMobile";
import { useModelsToolFilter } from "../../../../packages/ff-viewer-tools/src/hooks/useModelsToolFilter";
import { useViewerExpressIdMaps } from "../../../../packages/ff-viewer-tools/src/hooks/useViewerExpressIdMaps";
import { useViewerSelectionSync } from "../../../../packages/ff-viewer-tools/src/hooks/useViewerSelectionSync";

import CompassGizmo from "./CompassGizmo";
import EmptyViewerDropzone from "./EmptyViewerDropzone";

// Wave 63: the calibration wizard is code-split — it only loads when
// a mapping flow is opened.
const MappingView = lazy(() => import("@calibration/MappingView"));

export interface ViewerPanelProps {
  projectId: string;
  buildingId: string | null;
  /**
   * The ref the parent (AppShell) created for the <IfcViewer>
   * imperative handle. We forward it to <IfcViewer> so the
   * AppShell-owned ref and the IfcViewer's useImperativeHandle
   * are bound to the same object.
   */
  viewerRef: RefObject<IfcViewerHandle>;
}

const wrapperStyle: React.CSSProperties = {
  position: "relative",
  flex: 1,
  height: "100%",
  background: "var(--ff-bg-panel)",
  overflow: "hidden",
};

const emptyStateStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

/** The two filter-tool tenants of the mapping view's floating toolbar. */
type ViewerToolTenant = "models" | "filters";

const TOOL_BUTTONS: FrostedNavButton[] = [
  {
    id: "models",
    label: "Models & Levels",
    // Building module glyph (same path as the Models toolbar).
    path: "M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2zM4 11l8 4.5 8-4.5",
  },
  {
    id: "filters",
    label: "Filters",
    // Filter funnel glyph.
    path: "M3 5h18l-7 8v5l-4 2v-7L3 5z",
  },
];

const TOOL_TITLES: Record<ViewerToolTenant, string> = {
  models: "Models & Levels",
  filters: "Filters",
};

export default function ViewerPanel(props: ViewerPanelProps): ReactNode {
  // Wave 56-fix — the filter machinery needs the ViewerToolsProvider
  // context (dataSource), so the real body lives in an inner
  // component wrapped by the provider.
  return (
    <ViewerToolsProvider dataSource={modelsDataSource}>
      <ViewerPanelInner {...props} />
    </ViewerToolsProvider>
  );
}

function ViewerPanelInner({
  projectId,
  buildingId,
  viewerRef,
}: ViewerPanelProps): ReactNode {
  // The viewer states are independent slices of the same store.
  // We read `calibrationFlow` first (highest priority), then
  // `activePdfVersionId` (PDF canvas), then fall back to the
  // bare 3D viewer. The IfcViewer's own internal subscription
  // reads `activeViewId`.
  const calibrationFlow = useViewerStore((s) => s.calibrationFlow);
  const activePdfVersionId = useViewerStore((s) => s.activePdfVersionId);
  const setActivePdfVersionId = useViewerStore(
    (s) => s.setActivePdfVersionId,
  );

  // Wave 56-fix — apply the shared models-tool filter / manual
  // visibility / selection state to THIS viewer instance (the same
  // trio PersistentViewerSurface runs for the Models route). Toggling
  // a model or level in the toolbar below flips the shared
  // useModelsToolStore state and these hooks push it into the scene.
  const expressIdMaps = useViewerExpressIdMaps(viewerRef);
  useModelsToolFilter(expressIdMaps, viewerRef);
  useViewerSelectionSync(viewerRef);

  // The ONE floating slot's active tenant (null = closed). Defaults
  // closed so the mapping view is unobstructed until the maintainer asks
  // for the tools.
  const [activeTenant, setActiveTenant] =
    useState<ViewerToolTenant | null>(null);
  const isMobile = useIsMobile();

  const handleToggleTenant = useCallback((id: string) => {
    setActiveTenant((cur) =>
      cur === id ? null : (id as ViewerToolTenant),
    );
  }, []);

  const handleOpenLevel = useCallback(
    (levelName: string) => {
      void viewerRef.current?.openLevel(levelName);
    },
    [viewerRef],
  );

  // Reactive live query: when the building has IFCs, render the
  // viewer. Otherwise show the dropzone.
  const files = useIfcFiles(buildingId);
  const { loadIfc, isLoading, registerFragments } = useIfcPipeline();

  const handleUpload = async (picked: File[]) => {
    if (!buildingId) return;
    for (const file of picked) {
      try {
        await loadIfc(file, buildingId);
      } catch {
        // Pipeline surfaces the error via its own state; we just
        // continue with the next file rather than abort the batch.
      }
    }
  };

  // Removed: the previous `const hasIfc = files.length > 0;` gate
  // was the root cause of bug-hunt 2026-06-19 (commit 2dd8275).
  // IfcViewer is now always rendered when buildingId is set; it
  // handles empty files internally. We still keep `files` available
  // in case future UI (e.g. an "empty building" overlay) needs to
  // distinguish "0 files" from "loading".

  // Task 20 §1.8.1: pass the Settings-local viewer store as a
  // `viewerSlice` prop to <IfcViewer>. The viewer no longer
  // imports `useViewerStore` directly — it reads the slice from
  // props. This is the seam that lets the viewer live in a shared
  // package without coupling to a Settings-local store.
  const activeStoreyName = useViewerStore((s) => s.activeStoreyName);
  const setActiveStoreyName = useViewerStore(
    (s) => s.setActiveStoreyName,
  );

  // Audit-monorepo-diff-2026-06-19 §5 Risk #1: memoize the viewerSlice
  // object so its reference is stable across renders. If IfcViewer
  // ever adds `viewerSlice` to a useEffect dep array, an inline object
  // would cause an infinite loop (same anti-pattern as the
  // registerFragments bug we fixed in 17c95c0).
  const viewerSlice = useMemo(
    () => ({ activeStoreyName, setActiveStoreyName }),
    [activeStoreyName, setActiveStoreyName],
  );

  return (
    <div style={wrapperStyle} data-testid="viewer-panel">
      {/*
        Task 15: the IfcViewer is ALWAYS rendered when hasIfc,
        regardless of whether the calibration wizard is open.
        Previously the wizard would unmount the IfcViewer and
        mount a fresh one, losing the level view, the camera
        position, and forcing a model reload from IndexedDB.

        Keeping the IfcViewer mounted across the wizard open/close
        preserves all of that — the user sees the same level plan
        view they had when they clicked Map, and clicking Cancel
        returns them to exactly that view (no flash, no reload).

        The MappingView (when the wizard is open) is rendered
        AS AN OVERLAY on top of the IfcViewer, not in place of
        it. The wizard's bottom half is a transparent pane that
        shows the IfcViewer through it; the IfcViewer's debug
        overlay (zIndex 10) and stats panel remain visible in
        the bottom half. The 3D line SVG is portaled into the
        IfcViewer's container (via getContainer()).
      */}
      {/* Bug-hunt 2026-06-19: the previous `buildingId && hasIfc`
          gate unmounted <IfcViewer> whenever useIfcFiles briefly
          returned [] during Dexie's useLiveQuery dependency
          transition (building switch). The unmount disposed the
          OBC world + just-loaded models, producing both Bug 1
          (can't click back to a previous building) and Bug 2
          (model appears briefly then disappears). Render the
          IfcViewer whenever a building is selected; it handles
          an empty `files` array internally. */}
      {buildingId ? (
        <>
          <IfcViewer
            ref={viewerRef}
            projectId={projectId}
            activeBuildingId={buildingId}
            files={files}
            getFragBlob={getFragBlob}
            registerFragments={registerFragments}
            getStoreysForBuilding={getStoreysForBuilding}
            viewerSlice={viewerSlice}
          />
          <CompassGizmo />
        </>
      ) : (
        <EmptyViewerDropzone
          onFiles={handleUpload}
          busy={isLoading}
        />
      )}

      {calibrationFlow !== null ? (
        // Mapping mode (Task 12a Part 2 — calibration wizard).
        // Highest priority: when the wizard is open, the right
        // panel becomes a split view (PDF top, 3D bottom) via
        // an OVERLAY on top of the IfcViewer. The wizard uses
        // useViewerHandle() to get the parent's handle for
        // pickWorldPoint / worldToScreen / getContainer.
        //
        // activePdfVersionId is irrelevant here — MappingView
        // resolves the latest PDF version itself from the
        // calibration flow's pdfFileId.
        //
        // 2026-06-03 regression fix: the IfcViewer (rendered
        // above) is the first child and has `position: relative;
        // width: 100%; height: 100%`. Without an absolute
        // wrapper here, the MappingView would sit BELOW the
        // IfcViewer in document flow and be hidden by the
        // panel's `overflow: hidden`. Wrap in an absolute
        // container so it overlays on top instead.
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 11,
            // 2026-06-03 (Task 15 follow-up): the absolute
            // wrapper is `pointer-events: none` by default so
            // mouse events pass through to the IfcViewer's
            // canvas behind the wizard. Individual MappingView
            // children (status bar buttons, PDF pane, the 3D
            // pane during PICK_WORLD_* steps) opt back in with
            // their own `pointer-events: auto`. Without this,
            // the wrapper captures every event and the 3D
            // camera doesn't respond to drag/zoom.
            pointerEvents: "none",
          }}
          data-testid="viewer-panel-wizard-overlay"
        >
          <Suspense fallback={null}>
            <MappingView key={calibrationFlow.pdfFileId} />
          </Suspense>
        </div>
      ) : activePdfVersionId !== null ? (
        // PDF mode. The `key` prop forces a fresh mount whenever
        // the active version id changes — the overlay's own
        // useEffect keys on pdfVersionId, but a key bump is the
        // clearest way to ensure the previous viewer is fully
        // torn down (no leftover DOM, no pending render tasks).
        //
        // Same overlay-vs-below regression fix as the wizard
        // branch above.
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 11,
            // See the wizard branch above. The PDF overlay's
            // internal close button and toolbar opt back into
            // `pointer-events: auto` on their own; the wrapper
            // itself is a no-op for events. This matters less
            // for the PDF branch (the user expects clicks on
            // the PDF canvas to register as picks) but we keep
            // it consistent.
            pointerEvents: "none",
          }}
          data-testid="viewer-panel-pdf-overlay"
        >
          <PdfOverlay
            key={activePdfVersionId}
            pdfVersionId={activePdfVersionId}
            getPdfVersion={getPdfVersion}
            getPdfBlob={getPdfBlob}
            onClose={() => setActivePdfVersionId(null)}
          />
        </div>
      ) : !buildingId ? (
        // Bug-hunt 2026-06-19 (follow-up): the previous version of
        // this branch rendered unconditionally when no overlay was
        // active, which painted the "No building selected" message
        // OVER the <IfcViewer> for buildings that HAD loaded models.
        // Gate this on `!buildingId` so the empty state only shows
        // when there is genuinely no building selected.
        <div style={emptyStateStyle}>
          <div
            style={{
              color: "var(--ff-text-muted)",
              fontSize: 14,
              fontFamily: "var(--ff-font-stack)",
            }}
          >
            No building selected. Create one with +
          </div>
        </div>
      ) : null}

      {/* Wave 56-fix — the Models module's filter tools, floating over
          the viewer (FrostedNav geometry: top-left 14px, zIndex 21/22,
          above the MappingView overlay at zIndex 11). Visible whenever
          a building is selected — including during calibration, which
          is exactly when the maintainer needs to turn models on/off. */}
      {buildingId ? (
        <>
          <FrostedNavToolbar
            buttons={TOOL_BUTTONS}
            activeId={activeTenant}
            onToggle={handleToggleTenant}
            mobile={isMobile}
            ariaLabel="Viewer tools"
            testId="viewer-tools-toolbar"
          />
          <FrostedNavSlot
            open={activeTenant !== null}
            title={activeTenant ? TOOL_TITLES[activeTenant] : ""}
            onClose={() => setActiveTenant(null)}
            mobile={isMobile}
            testId="viewer-tools-panel"
          >
            {activeTenant === "models" ? (
              <ModelsLevelsPanel
                buildingId={buildingId}
                onOpenLevel={handleOpenLevel}
                activeLevelName={activeStoreyName}
              />
            ) : activeTenant === "filters" ? (
              <CustomFiltersPanel buildingId={buildingId} />
            ) : null}
          </FrostedNavSlot>
        </>
      ) : null}
    </div>
  );
}
