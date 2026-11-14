// apps/documents/src/DocumentsApp.tsx
//
// Wave 39 — the Documents route adopts the wave-35 toolbar chrome:
// a full-bleed viewer with a floating <FrostedNavToolbar> + one
// <FrostedNavSlot> panel.
//
// 2026-11-14 — Documents is PDF-only again: the Models & Levels and
// Filters tenants (wave 56) were removed from THIS toolbar at the
// Maintainer's request (Models / LinkView keep them). Two tenants
// remain: Documents, Outline. The toolbar + panel now sit below the
// open PDF's own tool row (usePdfToolbarHeight) instead of covering it.
//
// Wave 56 (history) — the Models module's filter tools MERGED into the
// same toolbar (spec §3): the single floating toolbar + single panel
// slot carried FOUR tenants, in order — Models & Levels, Filters,
// Documents, Outline. The model tools reuse @ff/viewer-tools'
// <ModelsLevelsPanel> / <CustomFiltersPanel> (byte-for-byte the Models
// module's tenants), backed by the shared modelsDataSource injected
// through <ViewerToolsProvider>. Toggling a model off here flips the
// shared useModelsToolStore state that the persistent 3D surface
// applies — no forking, no copy-paste variants.
//
// <TaskPinDock> + <PdfOverlay> stay untouched inside
// <DocumentsViewerPanel>.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";

// Task 38 — the outline + thumbnail panel drives the mounted
// <PdfOverlay> through its imperative handle. Type-only import.
import type { IfcViewerHandle, PdfOverlayHandle } from "@ff/viewer-react";

import { db } from "@ff/data/db/database";

import { modelsDataSource } from "../../models/src/modelsDataSource";
import { ViewerSurfaceHostSlot } from "../../models/src/viewerSurfaceHost";

import {
  FrostedNavSlot,
  FrostedNavToolbar,
  type FrostedNavButton,
} from "../../../packages/ff-viewer-tools/src/components/FrostedNav";
import { ViewerToolsProvider } from "../../../packages/ff-viewer-tools/src/dataSource";
import { useModelsToolStore } from "../../../packages/ff-viewer-tools/src/modelsToolStore";
import { useIsMobile } from "../../../packages/ff-viewer-tools/src/hooks/useIsMobile";

import { useProjectId } from "@ff/auth";
import DocumentsPanelBody from "./DocumentsPanelBody";
import { useDocumentsGroups } from "./hooks/useDocumentsGroups";
import DocumentsViewerPanel from "./DocumentsViewerPanel";
import PdfNavPanel from "./PdfNavPanel";
import { usePdfToolbarHeight } from "./hooks/usePdfToolbarHeight";
import { useDocumentsViewState } from "./documentsViewState";

/**
 * The merged tenants of the ONE Documents floating panel slot.
 * Model tools first, then the documents chrome (spec §3 requirement 6).
 */
type DocumentTenant = "docs" | "outline";

const NAV_BUTTONS: FrostedNavButton[] = [
  {
    id: "docs",
    label: "Documents",
    // Two stacked pages (24×24 grid, 1.8 stroke).
    path: "M7 3h7l4 4v13H7V3zM11 8h6l4 4v8H11V8z",
  },
  {
    id: "outline",
    label: "Outline",
    // List / outline glyph.
    path: "M4 6h16M4 12h16M4 18h10",
  },
];

const PANEL_TITLES: Record<DocumentTenant, string> = {
  docs: "Documents",
  outline: "Outline",
};

export interface DocumentsAppProps {
  /** The shared <IfcViewer> handle ref (from <ViewerKeepAlive>). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Register the viewport slot as the surface's portal target. */
  registerHost: (node: HTMLElement | null) => void;
}

export default function DocumentsApp({
  // `viewerRef` stays in the props contract (the shell passes it) but
  // Documents no longer drives the 3D surface since the model tools
  // left its toolbar (2026-11-14).
  registerHost,
}: DocumentsAppProps): ReactNode {
  const [activePdfVersionId, setActivePdfVersionId] = useState<string | null>(
    null,
  );
  // The ONE slot's active tenant, defaulting to `docs` (the pre-wave-56
  // behaviour: the documents panel is open on mount).
  const [activeTenant, setActiveTenant] = useState<DocumentTenant | null>("docs");

  // Task 38 — imperative handle of the mounted <PdfOverlay>. Owned
  // here because BOTH the viewer panel (which mounts the overlay) and
  // the `outline` tenant (PdfNavPanel) need it.
  const pdfOverlayRef = useRef<PdfOverlayHandle | null>(null);

  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore(
    (s) => s.setActiveBuildingId,
  );
  const isMobile = useIsMobile();

  // Auto-select the first building into the SHARED store once Dexie
  // hydrates — the same query DocumentsSidebar used (current project,
  // sorted by createdAt). The rail's combined switcher owns the
  // building dimension now; Models + Documents share the value.
  const projectId = useProjectId();
  const firstBuilding = useLiveQuery(async () => {
    if (!projectId) return null;
    const rows = await db.buildings
      .where("projectId")
      .equals(projectId)
      .toArray();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    return rows[0] ?? null;
  }, [projectId]);

  useEffect(() => {
    if (!firstBuilding) return;
    if (useModelsToolStore.getState().activeBuildingId === null) {
      setActiveBuildingId(firstBuilding.id);
    }
  }, [firstBuilding, setActiveBuildingId]);

  // Wave 41 — open the first PDF by default so the view never starts
  // blank. Once per building: after the user closes a PDF it stays
  // closed (we don't fight them); switching buildings re-arms it.
  const groups = useDocumentsGroups(activeBuildingId);
  const autoOpenedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!groups || groups.rows.length === 0) return;
    if (activePdfVersionId !== null) return;
    // Guard only applies once a building is actually selected — a
    // null building can never be "already auto-opened".
    if (
      activeBuildingId !== null &&
      autoOpenedForRef.current === activeBuildingId
    ) {
      return;
    }
    const firstVersionId = groups.rows[0]?.latestVersionId;
    if (!firstVersionId) return;
    autoOpenedForRef.current = activeBuildingId;
    setActivePdfVersionId(firstVersionId);
  }, [groups, activePdfVersionId, activeBuildingId]);

  // Wave 63 — a building switch closes the PDF of the old building
  // (it used to stay open over the new building's model). The
  // auto-open above then opens the new building's first PDF once.
  const prevBuildingRef = useRef<string | null>(activeBuildingId);
  useEffect(() => {
    const prev = prevBuildingRef.current;
    prevBuildingRef.current = activeBuildingId;
    if (prev !== null && prev !== activeBuildingId) {
      setActivePdfVersionId(null);
    }
  }, [activeBuildingId]);

  // Wave 63 — tell the settings shell when a PDF covers the shared 3D
  // surface, so it stops rendering frames nobody can see.
  const setPdfOpen = useDocumentsViewState((s) => s.setPdfOpen);
  useEffect(() => {
    setPdfOpen(activePdfVersionId !== null);
  }, [activePdfVersionId, setPdfOpen]);
  useEffect(() => () => setPdfOpen(false), [setPdfOpen]);

  const handleActivate = useCallback((versionId: string) => {
    setActivePdfVersionId(versionId);
  }, []);

  const handleClose = useCallback(() => {
    setActivePdfVersionId(null);
  }, []);

  const handleToggleTenant = useCallback((id: DocumentTenant) => {
    // Inactive → open; active → close; other → swap in place.
    setActiveTenant((cur) => (cur === id ? null : id));
  }, []);

  const handleClosePanel = useCallback(() => {
    setActiveTenant(null);
  }, []);

  // 2026-11-14 — the floating toolbar + panel sit BELOW the open
  // PDF's own tool row (page nav / zoom) instead of covering it.
  const shellRef = useRef<HTMLDivElement | null>(null);
  const pdfToolbarHeight = usePdfToolbarHeight(
    shellRef,
    activePdfVersionId !== null,
  );
  const navTop = 14 + pdfToolbarHeight;

  return (
    <ViewerToolsProvider dataSource={modelsDataSource}>
      <div ref={shellRef} style={shellStyle} className="ff-documents-shell">
        {/* Wave 56 — the shared 3D surface sits UNDERNEATH the PDF
            overlay (same host-seam pattern as /models and /linkview).
            The persistent surface portals into this full-bleed layer,
            behind <DocumentsViewerPanel> (which now has a transparent
            panel background so the 3D shows through when no PDF is
            active). */}
        <div style={surfaceLayerStyle} data-testid="documents-viewer-surface-layer">
          <ViewerSurfaceHostSlot
            registerHost={registerHost}
            testId="documents-viewer-surface"
          />
        </div>
        <DocumentsViewerPanel
          activePdfVersionId={activePdfVersionId}
          onClose={handleClose}
          pdfOverlayRef={pdfOverlayRef}
          buildingId={activeBuildingId}
        />
        <FrostedNavToolbar
          buttons={NAV_BUTTONS}
          activeId={activeTenant}
          onToggle={(id) => handleToggleTenant(id as DocumentTenant)}
          mobile={isMobile}
          ariaLabel="Documents navigation"
          testId="documents-nav-toolbar"
          top={navTop}
        />
        <DocumentsNavPanel
          activeTenant={activeTenant}
          activePdfVersionId={activePdfVersionId}
          onActivate={handleActivate}
          onClose={handleClosePanel}
          pdfOverlayRef={pdfOverlayRef}
          mobile={isMobile}
          top={navTop + 52}
        />
      </div>
    </ViewerToolsProvider>
  );
}

function DocumentsNavPanel({
  activeTenant,
  activePdfVersionId,
  onActivate,
  onClose,
  pdfOverlayRef,
  mobile,
  top,
}: {
  activeTenant: DocumentTenant | null;
  activePdfVersionId: string | null;
  onActivate: (versionId: string) => void;
  onClose: () => void;
  pdfOverlayRef: RefObject<PdfOverlayHandle> | null;
  mobile: boolean;
  top: number;
}): JSX.Element {
  const open = activeTenant !== null;

  return (
    <FrostedNavSlot
      open={open}
      title={activeTenant ? PANEL_TITLES[activeTenant] : ""}
      onClose={onClose}
      mobile={mobile}
      ariaLabel="Documents panel"
      testId="documents-nav-panel"
      dataPanel={activeTenant ?? "none"}
      top={top}
    >
      {activeTenant === "docs" && (
        <DocumentsPanelBody
          activePdfVersionId={activePdfVersionId}
          onActivate={onActivate}
        />
      )}
      {activeTenant === "outline" &&
        (activePdfVersionId ? (
          <PdfNavPanel
            overlayRef={pdfOverlayRef}
            activePdfVersionId={activePdfVersionId}
          />
        ) : (
          <div
            style={outlineEmptyStyle}
            data-testid="documents-nav-panel-outline-empty"
          >
            Open a PDF to see its outline
          </div>
        ))}
    </FrostedNavSlot>
  );
}

const shellStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
  overflow: "hidden",
  position: "relative",
};

/** Full-bleed layer the persistent 3D surface portals into (wave 56). */
const surfaceLayerStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  overflow: "hidden",
};

const outlineEmptyStyle: CSSProperties = {
  padding: "24px 8px",
  fontSize: 13,
  lineHeight: 1.5,
  color: "var(--ff-text-muted)",
  textAlign: "center",
};