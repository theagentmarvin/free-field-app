// apps/documents/src/DocumentsViewerPanel.tsx
//
// Right panel for the Documents module: hosts <PdfOverlay>
// (from @ff/viewer-react) keyed on the active PDF version id.
// Mirrors apps/settings/src/components/ViewerPanel.tsx's
// PdfOverlay mounting exactly — same props and
// CSS class hooks (no × close control) — so the user sees the same
// PDF viewer they get in Settings, just without the IFC
// model underneath.
//
// When no PDF is active, renders an empty-state placeholder
// ("Select a PDF from the sidebar"). The <PdfOverlay> stays
// unmounted until the user picks a row.

import type { CSSProperties, ReactNode, RefObject } from "react";

import { useEffect, useRef, useState } from "react";

import { PdfOverlay, type PdfOverlayHandle } from "@ff/viewer-react";
import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import type { PdfPinSurface } from "@ff/tasks-react";
import { useLiveQuery } from "dexie-react-hooks";

import { useProjectId } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { PdfMeasureLayer, pickCalibrationScale } from "@ff/viewer-tools/pdf-measure";

import CompareViewer from "./compare/viewer/CompareViewer";
import { useCompareStore } from "./compare/compareStore";
import { TaskPinDock, type PinVersionMeta, type TaskPinDockHandle } from "./TaskPinDock";
import SheetDataLayer, { type SheetDataLayerHandle } from "./sheetData/SheetDataLayer";

export interface DocumentsViewerPanelProps {
  /** The PDF version id to display, or null when nothing is selected. */
  activePdfVersionId: string | null;
  /**
   * Imperative handle of the mounted <PdfOverlay> (Task 38).
   * The Documents sidebar's outline + thumbnail panel reads the
   * document from it and drives navigation through it.
   */
  pdfOverlayRef?: RefObject<PdfOverlayHandle> | null;
  /** Active building — scopes the plan's task pins. */
  buildingId?: string | null;
  /** Open another PDF version (sheet links, "Back to <sheet>"). */
  onNavigate?: (pdfVersionId: string) => void;
  /** A tap picked an element of the drawing (opens the Properties panel). */
  onElementTapped?: () => void;
}

export default function DocumentsViewerPanel({
  activePdfVersionId,
  pdfOverlayRef,
  buildingId,
  onNavigate,
  onElementTapped,
}: DocumentsViewerPanelProps): ReactNode {
  // ── 2D task pins + tap-to-create (chunk 4 / Wave 5B) ───────
  // The panel owns the lightweight pin state (which PDF metadata is
  // live) because PdfOverlay's `onTap` lives here; everything
  // Firebase/Dexie-heavy is delegated to <TaskPinDock> — which mounts
  // ONLY while a PDF is active, so the empty-state path (and its
  // existing tests) never boots the tasks engine.
  const [version, setVersion] = useState<PinVersionMeta | null>(null);
  const dockRef = useRef<TaskPinDockHandle | null>(null);
  const sheetRef = useRef<SheetDataLayerHandle | null>(null);

  useEffect(() => {
    let alive = true;
    setVersion(null);
    if (!activePdfVersionId) return;
    void getPdfVersion(activePdfVersionId).then((row) => {
      if (!alive || !row) return;
      setVersion({ id: row.id, pdfFileId: row.pdfFileId, width: row.width, height: row.height });
    });
    return () => {
      alive = false;
    };
  }, [activePdfVersionId]);

  // Measuring: the page-1 calibration (current project, latest row)
  // gives metres per PDF point; pages without one use a manual scale or
  // show page units with an "uncalibrated" badge.
  const projectId = useProjectId();
  const pdfFileId = version?.pdfFileId ?? null;
  const calibrationRows = useLiveQuery(
    () => (pdfFileId ? db.calibrations.where("pdfFileId").equals(pdfFileId).toArray() : []),
    [pdfFileId],
  );
  const calibrationMetresPerUnit = pickCalibrationScale(calibrationRows ?? [], projectId);

  const compareActive = useCompareStore((s) => s.active);

  const getSurface = (): PdfPinSurface | null => pdfOverlayRef?.current ?? null;

  // The PDF viewer has no × close control: another sheet is picked from
  // the Documents panel, and the 3D model lives in the Models module.
  return (
    <div
      className="ff-documents-viewer-panel"
      style={panelStyle}
      data-testid="documents-viewer-panel"
    >
      {compareActive ? (
        <CompareViewer />
      ) : activePdfVersionId === null ? (
        <div style={emptyStyle} data-testid="documents-viewer-empty">
          <div style={emptyTitleStyle}>No PDF selected</div>
          <div style={emptyHintStyle}>
            Pick a PDF from the sidebar to view it here.
          </div>
        </div>
      ) : (
        // Same wrapper shape as apps/settings's ViewerPanel: a
        // full-bleed positioned container with pointer-events
        // enabled so the toolbar buttons (zoom/pan) are
        // interactive. data-testid lets tests target the overlay
        // mount without depending on @ff/viewer-react internals.
        <div
          style={overlayWrapStyle}
          data-testid="documents-viewer-pdf-overlay"
        >
          <PdfOverlay
            key={activePdfVersionId}
            ref={pdfOverlayRef}
            pdfVersionId={activePdfVersionId}
            getPdfVersion={getPdfVersion}
            getPdfBlob={getPdfBlob}
            // Wave 64 — the reader shows every page of a multi-page
            // PDF (page nav + the PdfNavPanel thumbnails / outline).
            allowMultiPage
            // Wave 5B: tap-to-create. A discriminated tap on the plan
            // anchors the + marker (the dock resolves the calibration
            // and opens compose on marker tap). No armed mode anymore —
            // the + marker is the sole creation entry point.
            onTap={(coords) => {
              sheetRef.current?.handleTap(coords);
              dockRef.current?.handleTap(coords);
            }}
          />
          <PdfMeasureLayer
            key={`measure-${activePdfVersionId}`}
            overlayRef={pdfOverlayRef}
            pdfVersionId={activePdfVersionId}
            calibrationMetresPerUnit={calibrationMetresPerUnit}
            fallbackPageSize={version ? { width: version.width, height: version.height } : null}
          />
          {onNavigate ? (
            <SheetDataLayer
              ref={sheetRef}
              overlayRef={pdfOverlayRef}
              pdfVersionId={activePdfVersionId}
              pdfFileId={version?.pdfFileId ?? null}
              page={version ? { width: version.width, height: version.height } : null}
              onNavigate={onNavigate}
              onElementTapped={onElementTapped}
            />
          ) : null}
          {version ? (
            <TaskPinDock
              ref={dockRef}
              version={version}
              getSurface={getSurface}
              buildingId={buildingId}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

const panelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  // Wave 56 — transparent so the shared 3D surface (rendered behind
  // this panel by the Documents route) shows through when no PDF is
  // active; a mounted <PdfOverlay> draws its own opaque page on top.
  background: "transparent",
  position: "relative",
  zIndex: 1,
  overflow: "hidden",
};

const emptyStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: 24,
  color: "var(--ff-text-muted)",
  textAlign: "center",
};

const emptyTitleStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--ff-text-primary)",
};

const emptyHintStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
};

const overlayWrapStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
};
