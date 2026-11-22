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

import { useDocumentsTaskOpen } from "./useDocumentsTaskOpen";
import {
  useCallback,
  useEffect,
  useMemo,
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
import TasksPanelBody from "./TasksPanelBody";
import { useSheetTasks, type SheetTasks } from "./hooks/useSheetTasks";
import ComparePanel from "./compare/ui/ComparePanel";
import { buildPrefill, useCompareStore } from "./compare/compareStore";
import ElementsPanelBody from "./sheetData/ElementsPanelBody";
import PropertiesPanelBody from "./sheetData/PropertiesPanelBody";
import SchedulesPanelBody from "./sheetData/SchedulesPanelBody";
import { useSheetDataStore } from "./sheetData/sheetDataStore";

/**
 * The merged tenants of the ONE Documents floating panel slot.
 * Model tools first, then the documents chrome (spec §3 requirement 6).
 */
type DocumentTenant = "docs" | "outline" | "tasks" | "compare" | "properties" | "elements" | "schedules";

/** Tenants that only exist while the open PDF carries drawing data. */
const SHEET_TENANTS: ReadonlySet<DocumentTenant> = new Set(["tasks", "properties", "elements", "schedules"]);

const SHEET_NAV_BUTTONS: Record<"properties" | "elements" | "schedules", FrostedNavButton> = {
  properties: {
    id: "properties",
    label: "Properties",
    // Info (circle with an i).
    path: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8v.01",
  },
  elements: {
    id: "elements",
    label: "Elements",
    // Four tiles.
    path: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  },
  schedules: {
    id: "schedules",
    label: "Schedules",
    // Table.
    path: "M4 5h16v14H4zM4 10h16M4 15h16M10 5v14",
  },
};

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

/** Right after Outline; present only while a sheet is open (its tasks). */
const TASKS_NAV_BUTTON: FrostedNavButton = {
  id: "tasks",
  label: "Tasks",
  // Checkbox ticks + lines (the Tasks module's icon).
  path: "M3 5l2 2 4-4M3 13l2 2 4-4M13 6h8M13 14h8",
};

/** Always last, after the drawing-data buttons. */
const COMPARE_NAV_BUTTON: FrostedNavButton = {
  id: "compare",
  label: "Compare revisions",
  // Two overlapping sheets.
  path: "M4 3h9v13H4V3zM11 8h9v13h-9V8z",
};

const PANEL_TITLES: Record<DocumentTenant, string> = {
  docs: "Documents",
  outline: "Outline",
  tasks: "Tasks",
  compare: "Compare revisions",
  properties: "Properties",
  elements: "Elements",
  schedules: "Schedules",
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
  // Drawing data of the open sheet: its buttons exist only when the PDF carries it.
  const sheetPayload = useSheetDataStore((s) => s.payload);
  // The Tasks button needs an open sheet (its tasks) — not the compare surface.
  const compareActive = useCompareStore((s) => s.active);
  const hasSheetOpen = activePdfVersionId !== null && !compareActive;
  const navButtons = useMemo<FrostedNavButton[]>(() => {
    const base = hasSheetOpen ? [...NAV_BUTTONS, TASKS_NAV_BUTTON] : NAV_BUTTONS;
    if (!sheetPayload) return [...base, COMPARE_NAV_BUTTON];
    return [
      ...base,
      SHEET_NAV_BUTTONS.properties,
      SHEET_NAV_BUTTONS.elements,
      ...(sheetPayload.schedules.length > 0 ? [SHEET_NAV_BUTTONS.schedules] : []),
      COMPARE_NAV_BUTTON,
    ];
  }, [sheetPayload, hasSheetOpen]);
  // A sheet panel cannot stay open on a PDF without drawing data.
  const shownTenant =
    activeTenant && SHEET_TENANTS.has(activeTenant) && !navButtons.some((b) => b.id === activeTenant)
      ? null
      : activeTenant;
  const openProperties = useCallback(() => setActiveTenant("properties"), []);

  // Task 38 — imperative handle of the mounted <PdfOverlay>. Owned
  // here because BOTH the viewer panel (which mounts the overlay) and
  // the `outline` tenant (PdfNavPanel) need it.
  const pdfOverlayRef = useRef<PdfOverlayHandle | null>(null);

  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  // Tasks placed on the open sheet: feeds the toolbar badge + the Tasks panel.
  const sheetTasks = useSheetTasks(pdfOverlayRef, activeBuildingId, hasSheetOpen);
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
      if (useCompareStore.getState().active) {
        useCompareStore.getState().close();
        setActiveTenant((cur) => (cur === "compare" ? "docs" : cur));
      }
    }
  }, [activeBuildingId]);

  // Wave 63 — tell the settings shell when a PDF covers the shared 3D
  // surface, so it stops rendering frames nobody can see.
  const setPdfOpen = useDocumentsViewState((s) => s.setPdfOpen);
  useEffect(() => () => setPdfOpen(false), [setPdfOpen]);

  const handleActivate = useCallback((versionId: string) => {
    setActivePdfVersionId(versionId);
  }, []);

  // Task quick access: open the sheet at the task's page and pin.
  useDocumentsTaskOpen(pdfOverlayRef, activeBuildingId, activePdfVersionId, handleActivate);

  const compareBuildingId = useCompareStore((s) => s.buildingId);

  // A compare left running while the building was switched elsewhere (this
  // module was unmounted at the time) is stale: end it.
  useEffect(() => {
    if (compareActive && compareBuildingId !== null && compareBuildingId !== activeBuildingId) {
      useCompareStore.getState().close();
      setActiveTenant((cur) => (cur === "compare" ? "docs" : cur));
    }
  }, [compareActive, compareBuildingId, activeBuildingId]);

  // Compare — an open PDF or active compare covers the 3D surface, so the
  // shell can pause it.
  useEffect(() => {
    setPdfOpen(activePdfVersionId !== null || compareActive);
  }, [activePdfVersionId, compareActive, setPdfOpen]);

  const rowsRef = useRef(groups?.rows);
  rowsRef.current = groups?.rows;

  /** Enter compare, pre-filled from `fileId` (row action) or the open PDF. */
  const openCompare = useCallback(
    (fileId: string | null) => {
      const rows = rowsRef.current ?? [];
      const row =
        fileId !== null
          ? rows.find((r) => r.file?.id === fileId)
          : rows.find((r) => (r.versions ?? []).some((v) => v.id === activePdfVersionId));
      const prefill = row
        ? buildPrefill(row.versions ?? [], fileId !== null ? null : activePdfVersionId)
        : null;
      const store = useCompareStore.getState();
      // Re-opening an active compare keeps its state unless a row asked.
      store.open(fileId !== null || !store.active ? prefill : undefined, activeBuildingId);
    },
    [activePdfVersionId, activeBuildingId],
  );

  const handleCompareFile = useCallback(
    (fileId: string) => {
      openCompare(fileId);
      setActiveTenant("compare");
    },
    [openCompare],
  );

  const handleToggleTenant = useCallback(
    (id: DocumentTenant) => {
      // Inactive → open; active → close; other → swap in place.
      if (id === "compare" && activeTenant !== "compare") openCompare(null);
      setActiveTenant((cur) => (cur === id ? null : id));
    },
    [activeTenant, openCompare],
  );

  const handleExitCompare = useCallback(() => {
    // The previously open PDF was never closed; the viewer swaps back.
    setActiveTenant((cur) => (cur === "compare" ? "docs" : cur));
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
          pdfOverlayRef={pdfOverlayRef}
          buildingId={activeBuildingId}
          onNavigate={handleActivate}
          onElementTapped={openProperties}
        />
        <FrostedNavToolbar
          buttons={navButtons}
          activeId={shownTenant}
          onToggle={(id) => handleToggleTenant(id as DocumentTenant)}
          badges={{ tasks: sheetTasks.onPage.length }}
          mobile={isMobile}
          ariaLabel="Documents navigation"
          testId="documents-nav-toolbar"
          top={navTop}
        />
        <DocumentsNavPanel
          activeTenant={shownTenant}
          activePdfVersionId={activePdfVersionId}
          onActivate={handleActivate}
          onCompareFile={handleCompareFile}
          onExitCompare={handleExitCompare}
          onClose={handleClosePanel}
          pdfOverlayRef={pdfOverlayRef}
          sheetTasks={sheetTasks}
          mobile={isMobile}
          top={navTop + 52}
          onOpenProperties={openProperties}
        />
      </div>
    </ViewerToolsProvider>
  );
}

function DocumentsNavPanel({
  activeTenant,
  activePdfVersionId,
  onActivate,
  onCompareFile,
  onExitCompare,
  onClose,
  pdfOverlayRef,
  sheetTasks,
  mobile,
  top,
  onOpenProperties,
}: {
  onOpenProperties: () => void;
  activeTenant: DocumentTenant | null;
  activePdfVersionId: string | null;
  onActivate: (versionId: string) => void;
  onCompareFile: (fileId: string) => void;
  onExitCompare: () => void;
  onClose: () => void;
  pdfOverlayRef: RefObject<PdfOverlayHandle> | null;
  sheetTasks: SheetTasks;
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
          onCompare={onCompareFile}
        />
      )}
      {activeTenant === "compare" && <ComparePanel onExit={onExitCompare} mobile={mobile} onCollapse={onClose} />}
      {activeTenant === "tasks" && (
        <TasksPanelBody
          tasks={sheetTasks.tasks}
          currentPage={sheetTasks.currentPage}
          overlayRef={pdfOverlayRef}
        />
      )}
      {activeTenant === "properties" && <PropertiesPanelBody />}
      {activeTenant === "elements" && <ElementsPanelBody onElementPicked={onOpenProperties} />}
      {activeTenant === "schedules" && <SchedulesPanelBody />}
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