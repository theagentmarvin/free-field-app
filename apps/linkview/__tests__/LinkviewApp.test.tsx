// __tests__/LinkviewApp.test.tsx
//
// Wave 52 — Linkview shell tests, reworked around the shared 3D
// surface. The RIGHT pane now portals the shared persistent surface
// (passed in as `viewerRef`) and layers the toolbar + properties
// drawer; the LEFT pane keeps a level-plan IfcViewer.
//
// Wave 55 — chrome correction: the sidebar is gone; the TOOLS
// toolbar (top-left of the 3D pane) carries the Mapped PDFs /
// Model Floor Plans panel toggles + the Split View | Overlap mode
// buttons; the viewer tools toolbar keeps Measure + Save view only;
// non-blank open prioritizes the first mapped PDF and RETRIES a
// parked openLevel on the left viewer's model-load event; model
// level plans get the PDF-style navigation cluster (zoom/fit).
//
// Covered:
//   - tools toolbar + split canvas mount (no sidebar)
//   - right pane hosts the shared surface slot + toolbar + drawer
//   - mode toggle in the tools toolbar (Split View | Overlap) persists
//   - Overlap hides the divider and activates the floor clip plane
//   - non-blank open: mapped PDF first; else lowest extracted storey
//     → openLevel; fallback to lowest model storey; empty only when
//     neither exists; parked open replays on model load
//   - Model Floor Plans row click → openLevel on the LEFT viewer
//   - plan nav cluster: zoom in/out replay synthetic wheels; fit
//     calls fitLevelPlan

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { forwardRef, useImperativeHandle, createElement } from "react";

const recorded = vi.hoisted(() => ({
  openLevelCalls: [] as string[],
  closeLevelCalls: 0,
  setActiveToolCalls: [] as ("navigation" | "measure")[],
  setFloorClipPlaneCalls: [] as Array<{ enabled: boolean; floorZ: number }>,
  addFloorPlanPlaneCalls: 0,
  removeFloorPlanPlaneCalls: 0,
  setOnElementPickCalls: 0,
  setMeasureModeCalls: [] as Array<[string, string]>,
  // Wave 55 — plan nav + openLevel-retry machinery.
  zoomCalls: [] as number[],
  fitLevelPlanCalls: 0,
  openLevelResult: true,
  loadedModelsCbs: [] as Array<(count: number) => void>,
  // Wave 64 — legacy `onLoadedModelsChange(null)` (clear-ALL) calls.
  loadedModelsNullClears: 0,
  // Wave 57 — nav view (surface camera pose).
  setViewPoseCalls: [] as Array<{
    pose: { pos: number[]; target: number[]; fov: number; isOrtho: boolean };
    animate?: boolean;
  }>,
  getPoseResult: null as {
    pos: number[];
    target: number[];
    fov: number;
    isOrtho: boolean;
  } | null,
  // Wave 58 — configurable model centroid for the seed bearing.
  modelCentroid: null as { x: number; y: number; z: number } | null,
  // Perf — every getPose call's options + the surface's viewport
  // revision token (bump it to signal a camera move).
  getPoseOptions: [] as Array<{ silent?: boolean } | undefined>,
  viewportRevision: 0,
  // First-person controls — camera writes + orbit lock/release.
  navigateToCalls: [] as Array<{
    eye: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  }>,
  restrictedCalls: 0,
  releaseCalls: 0,
  // When true, setViewPose / navigateTo / setRestrictedThirdPerson
  // write through to getPoseResult (a live camera).
  liveCamera: false,
}));

function clearRecordedCalls(): void {
  recorded.openLevelCalls = [];
  recorded.closeLevelCalls = 0;
  recorded.setActiveToolCalls = [];
  recorded.setFloorClipPlaneCalls = [];
  recorded.addFloorPlanPlaneCalls = 0;
  recorded.removeFloorPlanPlaneCalls = 0;
  recorded.setOnElementPickCalls = 0;
  recorded.setMeasureModeCalls = [];
  recorded.zoomCalls = [];
  recorded.fitLevelPlanCalls = 0;
  recorded.openLevelResult = true;
  recorded.loadedModelsCbs = [];
  recorded.loadedModelsNullClears = 0;
  recorded.setViewPoseCalls = [];
  recorded.getPoseResult = null;
  recorded.modelCentroid = null;
  recorded.getPoseOptions = [];
  recorded.viewportRevision = 0;
  recorded.navigateToCalls = [];
  recorded.restrictedCalls = 0;
  recorded.releaseCalls = 0;
  recorded.liveCamera = false;
}

type V3 = { x: number; y: number; z: number };
function writeLivePose(rec: typeof recorded, eye: V3, target: V3): void {
  if (!rec.liveCamera) return;
  rec.getPoseResult = {
    pos: [eye.x, eye.y, eye.z],
    target: [target.x, target.y, target.z],
    fov: rec.getPoseResult?.fov ?? 45,
    isOrtho: false,
  };
  rec.viewportRevision += 1;
}

/** A full IfcViewerHandle-shaped mock (shared surface + left viewer). */
function makeHandle(
  rec: typeof recorded,
  viewerSlice?: { setActiveStoreyName?: (n: string | null) => void },
): Record<string, unknown> {
  return {
    openLevel: async (name: string) => {
      rec.openLevelCalls.push(name);
      if (!rec.openLevelResult) return false;
      viewerSlice?.setActiveStoreyName?.(name);
      return true;
    },
    fitLevelPlan: async () => {
      rec.fitLevelPlanCalls += 1;
      return true;
    },
    closeLevel: () => {
      rec.closeLevelCalls += 1;
      viewerSlice?.setActiveStoreyName?.(null);
    },
    setActiveTool: (tool: "navigation" | "measure") => {
      rec.setActiveToolCalls.push(tool);
    },
    setFloorClipPlane: (enabled: boolean, floorZ: number) => {
      rec.setFloorClipPlaneCalls.push({ enabled, floorZ });
    },
    addFloorPlanPlane: () => {
      rec.addFloorPlanPlaneCalls += 1;
      return `plane-${rec.addFloorPlanPlaneCalls}`;
    },
    removeFloorPlanPlane: () => {
      rec.removeFloorPlanPlaneCalls += 1;
    },
    setMeasureMode: (mode: string, variant?: string) => {
      rec.setMeasureModeCalls.push([mode, variant ?? ""]);
    },
    onMeasureReadout: () => undefined,
    isMeasureInProgress: () => false,
    cancelMeasureCreation: () => undefined,
    clearMeasurements: () => undefined,
    getPose: (opts?: { silent?: boolean }) => {
      rec.getPoseOptions.push(opts);
      return rec.getPoseResult;
    },
    getSectionPlanes: () => [],
    setViewPose: (
      pose: { pos: number[]; target: number[]; fov: number; isOrtho: boolean },
      opts?: { animate?: boolean },
    ) => {
      rec.setViewPoseCalls.push({ pose, animate: opts?.animate });
      writeLivePose(
        rec,
        { x: pose.pos[0], y: pose.pos[1], z: pose.pos[2] },
        { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      );
    },
    clearSectionPlanes: () => undefined,
    addSectionPlane: () => true,
    getSectionPlaneCount: () => 0,
    getSelection: () => new Map(),
    selectElement: () => undefined,
    clearSelection: () => undefined,
    getElementData: async () => null,
    setElementVisibility: () => undefined,
    getAllModelExpressIds: async () => new Map(),
    getModelLevelLocalIds: async () => null,
    getPropertyDataForModel: async () => null,
    onLoadedModelsChange: (cb: ((count: number) => void) | null) => {
      if (!cb) {
        rec.loadedModelsNullClears += 1;
        rec.loadedModelsCbs = [];
        return () => undefined;
      }
      rec.loadedModelsCbs.push(cb);
      return () => {
        rec.loadedModelsCbs = rec.loadedModelsCbs.filter((c) => c !== cb);
      };
    },
    onSelectionChange: () => undefined,
    setOnElementPick: () => {
      rec.setOnElementPickCalls += 1;
    },
    loadedModelIds: new Set<string>(),
    getContainer: () => null,
    zoom: (deltaY: number) => {
      rec.zoomCalls.push(deltaY);
    },
    update: async () => undefined,
    resetCameraToDefault: () => undefined,
    releaseRestrictedCamera: () => {
      rec.releaseCalls += 1;
    },
    setRestrictedThirdPerson: (eye: V3, target: V3) => {
      rec.restrictedCalls += 1;
      writeLivePose(rec, eye, target);
    },
    navigateTo: (eye: V3, target: V3) => {
      rec.navigateToCalls.push({ eye, target });
      writeLivePose(rec, eye, target);
    },
    unprojectToFloorPlane: () => null,
    pickWorldPoint: async () => null,
    worldToScreen: () => null,
    getViewportRevision: () => rec.viewportRevision,
    getModelVersionKey: () => null,
    getModelCentroid: () => rec.modelCentroid,
    getLevelPlanDistance: () => 50,
    getActiveStoreyFloorZ: () => null,
    getSelectionWorldPoint: () => null,
    getSelectionWorldCenter: async () => null,
    getSelectionWorldNormal: () => null,
    isSelectionPointPending: () => false,
  };
}

// Mock @ff/viewer-react BEFORE importing LinkviewApp.
vi.mock("@ff/viewer-react", () => {
  const IfcViewer = forwardRef<
    Record<string, unknown>,
    { viewerSlice?: { activeStoreyName: string | null; setActiveStoreyName: (n: string | null) => void }; loadingOverlay?: boolean; renderPaused?: boolean }
  >(function MockIfcViewer(_props, ref) {
    useImperativeHandle(ref, () => makeHandle(recorded, _props.viewerSlice));
    return createElement("div", {
      "data-testid": "mock-ifc-viewer",
      "data-loading-overlay": String(_props.loadingOverlay ?? true),
      "data-render-paused": String(_props.renderPaused ?? false),
    });
  });
  IfcViewer.displayName = "MockIfcViewer";
  const PdfOverlay = forwardRef<Record<string, unknown>, Record<string, unknown>>(
    function MockPdfOverlay(_props, ref) {
      useImperativeHandle(ref, () => ({
        getAnnotationLayer: () =>
          typeof document !== "undefined"
            ? document.querySelector('[data-pv-annotation-layer="true"]')
            : null,
        getTotalScale: () => 1,
        onReady: (cb: () => void) => {
          cb();
        },
        setOnScaleChange: () => (): void => {},
      }));
      return createElement(
        "div",
        { "data-testid": "mock-pdf-overlay" },
        createElement("div", { "data-pv-annotation-layer": "true" }),
      );
    },
  );
  PdfOverlay.displayName = "MockPdfOverlay";
  return { IfcViewer, PdfOverlay };
});

// Mock the direct models import the split canvas uses for the host slot.
vi.mock("../../models/src/viewerSurfaceHost", () => ({
  ViewerSurfaceHostSlot: ({
    registerHost,
    testId,
  }: {
    registerHost: (n: HTMLElement | null) => void;
    testId?: string;
  }) => {
    // Register a marker the host slot is present (jsdom has no portal).
    // The node itself is registered (like the real slot) so the
    // first-person drag-look can listen on it.
    return createElement("div", {
      ref: registerHost,
      "data-testid": "mock-viewer-surface-host-slot",
      "data-slot": testId ?? "slot",
    });
  },
}));

// Mock the models toolbar-state/viewpoint tooling the toolbar imports.
vi.mock("@ff/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/data")>();
  return {
    ...actual,
    createViewerViewpoint: vi.fn(async () => ({ id: "vp-1" })),
    deleteViewerViewpoint: vi.fn(async () => undefined),
    listViewerViewpoints: vi.fn(async () => []),
  };
});

// The 2D task-pin layer reads the tasks source (needs an AuthProvider); the
// shell tests do not exercise it.
vi.mock("@ff/tasks-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ff/tasks-react")>()),
  TaskCalloutLayer2D: () => null,
}));

const authMock = vi.hoisted(() => ({ projectId: "p1" as string | undefined }));
vi.mock("@ff/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ff/auth")>()),
  useProjectId: () => authMock.projectId,
}));

import { LinkviewApp } from "../src";
import { EYE_HEIGHT } from "../src/linkviewNav";

import { db } from "@ff/data/db/database";
import { useModelsToolStore } from "@ff/viewer-tools";
import type {
  BuildingRecord,
  CalibrationRecord,
  ExtractedStoreyRecord,
  PdfFileRecord,
  PdfVersionRecord,
  StoreyRecord,
} from "@ff/types";

// ── Fixtures ─────────────────────────────────────────────────────────

function resetSharedStore(): void {
  const s = useModelsToolStore.getState();
  s.setActiveBuildingId(null);
  s.setActiveStoreyName(null);
  s.clearSelection();
}

async function clearAllTables(): Promise<void> {
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
}

async function seedBuilding(id: string, name: string): Promise<BuildingRecord> {
  const b: BuildingRecord = {
    id,
    projectId: "p1",
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
  };
  await db.buildings.add(b);
  return b;
}

async function seedPdf(
  building: BuildingRecord,
  fileId: string,
  filename: string,
): Promise<{ file: PdfFileRecord; version: PdfVersionRecord }> {
  const file: PdfFileRecord = {
    id: fileId,
    buildingId: building.id,
    name: filename,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.pdfFiles.add(file);
  const version: PdfVersionRecord = {
    id: `${fileId}-v1`,
    pdfFileId: file.id,
    versionNumber: 1,
    name: filename,
    size: 1024,
    contentHash: `hash-${file.id}-1`,
    pageCount: 1,
    width: 595,
    height: 842,
    storedAt: Date.now(),
    blobKey: `blob-${file.id}-1`,
    isLatest: true,
  };
  await db.pdfVersions.add(version);
  return { file, version };
}

async function seedStorey(
  building: BuildingRecord,
  id: string,
  name: string,
  elevation: number,
  ifcVersionId = "ifcv-test",
): Promise<StoreyRecord> {
  const s: StoreyRecord = {
    id,
    buildingId: building.id,
    ifcVersionId,
    sourceIfcFileId: "ifc-test",
    name,
    elevation,
    expressId: 1,
    height: 3,
    containedElementIds: [],
  };
  await db.storeys.add(s);
  return s;
}

async function seedCalibration(
  pdfFileId: string,
  storeyName: string,
): Promise<CalibrationRecord> {
  const c: CalibrationRecord = {
    id: `cal-${pdfFileId}-${storeyName}`,
    projectId: "p1",
    pdfFileId,
    storeyName,
    pointPairs: [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 1, worldX: 1, worldZ: 1 },
    ],
    transformParams: {
      scale: 1,
      rotation: 0,
      translateX: 0,
      translateZ: 0,
    },
    confidence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.calibrations.add(c);
  return c;
}

async function seedExtracted(
  building: BuildingRecord,
  storeyId: string,
): Promise<ExtractedStoreyRecord> {
  const e: ExtractedStoreyRecord = {
    id: `ext-${building.id}-${storeyId}`,
    buildingId: building.id,
    storeyId,
    updatedAt: Date.now(),
  };
  await db.extractedStoreys.add(e);
  return e;
}

function renderApp(overrides: { surfaceLoaded?: boolean } = {}) {
  const surfaceHandle = makeHandle(recorded);
  const viewerRef = { current: surfaceHandle as never };
  const registerHost = vi.fn();
  return render(
    <LinkviewApp
      viewerRef={viewerRef as never}
      registerHost={registerHost}
      surfaceLoaded={overrides.surfaceLoaded ?? true}
    />,
  );
}

describe("LinkviewApp — shared surface shell", () => {
  beforeEach(async () => {
    authMock.projectId = "p1";
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("does no project-scoped read or write while the project id is undefined", async () => {
    await seedBuilding("b-torre-a", "Torre A");
    authMock.projectId = undefined;
    const projectsBefore = await db.projects.count();
    renderApp();
    expect(await screen.findByTestId("linkview-tools-toolbar")).toBeInTheDocument();
    // No viewer-tools toolbar (it needs a project), no auto-picked
    // building, and no local project row bootstrap.
    expect(screen.queryByTestId("linkview-toolbar")).not.toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(useModelsToolStore.getState().activeBuildingId).toBeNull();
    expect(await db.projects.count()).toBe(projectsBefore);
  });

  it("does not auto-pick a building from another project", async () => {
    const b = await seedBuilding("b-other", "Other");
    await db.buildings.update(b.id, { projectId: "p2" });
    renderApp();
    expect(await screen.findByTestId("linkview-tools-toolbar")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(useModelsToolStore.getState().activeBuildingId).toBeNull();
  });

  it("mounts the tools toolbar, split canvas, viewer tools toolbar and properties drawer (no sidebar)", async () => {
    renderApp();

    expect(
      await screen.findByTestId("linkview-tools-toolbar"),
    ).toBeInTheDocument();
    // Wave 55 — the persistent left sidebar is gone.
    expect(screen.queryByTestId("linkview-sidebar")).not.toBeInTheDocument();
    expect(screen.getByTestId("linkview-split-canvas")).toBeInTheDocument();
    // Wave 52 — the shared surface slot replaces the old right IfcViewer.
    expect(
      screen.getByTestId("mock-viewer-surface-host-slot"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("linkview-toolbar")).toBeInTheDocument();
    expect(
      screen.getByTestId("linkview-properties-panel"),
    ).toBeInTheDocument();
  });

  it("renders the mode toggle in the tools toolbar; the viewer tools toolbar keeps measure + save view only", async () => {
    renderApp();
    await screen.findByTestId("linkview-tools-toolbar");

    expect(screen.getByTestId("linkview-tools-split")).toBeInTheDocument();
    expect(screen.getByTestId("linkview-tools-overlap")).toBeInTheDocument();
    expect(screen.getByTestId("linkview-tools-pdfs")).toBeInTheDocument();
    expect(screen.getByTestId("linkview-tools-plans")).toBeInTheDocument();
    // Wave 55 — the mode toggle moved OUT of the viewer tools toolbar.
    expect(
      screen.queryByTestId("linkview-toolbar-split"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("linkview-toolbar-overlap"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("linkview-toolbar-measure")).toBeInTheDocument();
    expect(
      screen.getByTestId("linkview-toolbar-save-view-button"),
    ).toBeInTheDocument();
  });

  it("suppresses the left-pane loading overlay when the shared surface is loaded", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    await seedStorey(building, "st-ground", "Ground Floor", 0);

    // surfaceLoaded=true → the left IfcViewer's overlay is suppressed.
    const { unmount } = renderApp({ surfaceLoaded: true });
    await screen.findByTestId("mock-ifc-viewer");
    expect(screen.getByTestId("mock-ifc-viewer")).toHaveAttribute(
      "data-loading-overlay",
      "false",
    );
    unmount();

    clearRecordedCalls();
    // surfaceLoaded=false → the left IfcViewer keeps its loader.
    renderApp({ surfaceLoaded: false });
    await screen.findByTestId("mock-ifc-viewer");
    expect(screen.getByTestId("mock-ifc-viewer")).toHaveAttribute(
      "data-loading-overlay",
      "true",
    );
  });

  it("persists the mode and enters Overlap (divider hidden, clip plane active)", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 12.5);
    const { file } = await seedPdf(building, "pdf-plan", "Plan.pdf");
    await seedCalibration(file.id, ground.name);

    renderApp();
    await screen.findByTestId("linkview-split-canvas");

    // Default is split: divider present.
    expect(screen.getByTestId("linkview-split-divider")).toBeInTheDocument();
    expect(screen.getByTestId("linkview-split-canvas")).toHaveAttribute(
      "data-mode",
      "split",
    );

    // Wave 55 — the mapped-PDF list lives in the panel slot; open the
    // Mapped PDFs tenant from the tools toolbar. (The non-blank open
    // already auto-selected the first mapped PDF — the click keeps the
    // explicit user path covered.)
    fireEvent.click(screen.getByTestId("linkview-tools-pdfs"));
    const pdfRow = await screen.findByTestId(`linkview-pdf-row-${file.name}`);
    fireEvent.click(pdfRow);

    // Toggle Overlap (tools toolbar, wave 55).
    fireEvent.click(screen.getByTestId("linkview-tools-overlap"));

    await waitFor(() => {
      expect(screen.getByTestId("linkview-split-canvas")).toHaveAttribute(
        "data-mode",
        "overlap",
      );
    });
    expect(screen.queryByTestId("linkview-split-divider")).not.toBeInTheDocument();
    // Persisted to localStorage.
    expect(window.localStorage.getItem("ff:linkview:mode")).toBe("overlap");
    // The floor clip plane is activated at the calibrated floor elevation.
    await waitFor(() => {
      expect(recorded.setFloorClipPlaneCalls).toContainEqual({
        enabled: true,
        floorZ: 12.5,
      });
    });
  });
});

describe("LinkviewApp — non-blank open", () => {
  beforeEach(async () => {
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("auto-selects the lowest extracted storey and calls openLevel(name)", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    const first = await seedStorey(building, "st-first", "First Floor", 3);
    await seedExtracted(building, ground.id);
    await seedExtracted(building, first.id);

    renderApp();

    // The lowest (Ground Floor) auto-opens.
    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain("Ground Floor");
    });
    expect(recorded.openLevelCalls[0]).toBe("Ground Floor");
  });

  it("falls back to the lowest model storey when none are extracted", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedStorey(building, "st-first", "First Floor", 3);

    renderApp();

    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain("Ground Floor");
    });
  });

  it("leaves the empty pane when the building has no storeys", async () => {
    await seedBuilding("b-torre-a", "Torre A");

    renderApp();

    // No storeys → no openLevel, the "Nothing selected" empty pane shows.
    await screen.findByTestId("linkview-left-empty");
    expect(recorded.openLevelCalls.length).toBe(0);
  });

  it("wave 55: auto-selects the first mapped PDF ahead of any level", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);
    const { file } = await seedPdf(building, "pdf-plan", "Plan.pdf");
    await seedCalibration(file.id, ground.name);

    renderApp();

    // The mapped PDF wins the priority → the PdfOverlay covers the
    // left pane and no level plan is opened.
    await screen.findByTestId("linkview-pdf-overlay");
    expect(recorded.openLevelCalls.length).toBe(0);
  });

  it("wave 55: retries the parked openLevel once the left viewer's models load", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);
    // First attempts fail: the level-plan metadata only lands after
    // the first model load (the wave-52 non-blank-open bug).
    recorded.openLevelResult = false;

    renderApp();

    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain("Ground Floor");
    });
    expect(recorded.setActiveToolCalls).not.toContain("navigation");

    // Models land → the onLoadedModelsChange subscription fires →
    // the parked open replays and completes.
    recorded.openLevelResult = true;
    await waitFor(() => {
      expect(recorded.loadedModelsCbs.length).toBeGreaterThan(0);
    });
    recorded.loadedModelsCbs.forEach((cb) => cb(1));

    await waitFor(() => {
      expect(recorded.setActiveToolCalls).toContain("navigation");
    });
    expect(
      recorded.openLevelCalls.filter((n) => n === "Ground Floor").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("wave 64: unsubscribes only its own loaded-models listener (never clears all)", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);
    recorded.openLevelResult = false;

    const { unmount } = renderApp();
    await waitFor(() => {
      expect(recorded.loadedModelsCbs.length).toBeGreaterThan(0);
    });
    // A foreign subscriber on the same handle must survive LinkView's
    // re-subscribe / cleanup cycles.
    const foreign = vi.fn();
    recorded.loadedModelsCbs.push(foreign);
    recorded.openLevelResult = true;
    recorded.loadedModelsCbs.slice().forEach((cb) => cb(1));
    await waitFor(() => {
      expect(recorded.setActiveToolCalls).toContain("navigation");
    });
    unmount();
    expect(recorded.loadedModelsNullClears).toBe(0);
    expect(recorded.loadedModelsCbs).toEqual([foreign]);
  });
});

describe("LinkviewApp — left-pane storey activation", () => {
  beforeEach(async () => {
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("calls openLevel on the LEFT viewer when a Model Floor Plans row is clicked", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);

    renderApp();

    // The auto-select already opens the lowest storey; clear for the
    // explicit row-click assertion.
    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain("Ground Floor");
    });
    clearRecordedCalls();

    // Wave 55 — the Model Floor Plans list lives in the panel slot.
    fireEvent.click(screen.getByTestId("linkview-tools-plans"));
    const row = await screen.findByTestId(
      `linkview-storey-row-${ground.name}`,
    );
    fireEvent.click(row);

    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain(ground.name);
    });
    expect(recorded.setActiveToolCalls).toContain("navigation");
  });
});

describe("LinkviewApp — plan navigation cluster (wave 55)", () => {
  beforeEach(async () => {
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("shows zoom/fit controls over an active model level plan and wires them to the handle", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);

    renderApp();

    // The non-blank open activates the level plan → the cluster shows.
    const nav = await screen.findByTestId("linkview-plan-nav");
    expect(nav).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("linkview-plan-zoom-in"));
    expect(recorded.zoomCalls[0]).toBeLessThan(0);
    fireEvent.click(screen.getByTestId("linkview-plan-zoom-out"));
    expect(recorded.zoomCalls[1]).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId("linkview-plan-fit"));
    await waitFor(() => {
      expect(recorded.fitLevelPlanCalls).toBe(1);
    });
  });

  it("hides the cluster while a mapped PDF covers the left pane", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    const { file } = await seedPdf(building, "pdf-plan", "Plan.pdf");
    await seedCalibration(file.id, ground.name);

    renderApp();

    await screen.findByTestId("linkview-pdf-overlay");
    expect(screen.queryByTestId("linkview-plan-nav")).not.toBeInTheDocument();
  });
});

// ── Wave 57/58: navigation view seeded from the floor-plan calibration ──
// jsdom has no `window.PointerEvent` (see SelectionContextToolbar.test),
// so we dispatch a MouseEvent named "pointerdown|move|up" — React's
// onPointer* handlers fire on the type name and keep the client coords.
function firePointer(
  el: Element,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: { clientX?: number; clientY?: number } = {},
): void {
  el.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: init.clientX ?? 0,
      clientY: init.clientY ?? 0,
    }),
  );
}

describe("LinkviewApp — navigation view (wave 57/58)", () => {
  beforeEach(async () => {
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("calibrated PDF open seeds the nav pose + marker at the calibration start point", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    // Wave 58 — the seed bearing points toward the model centroid.
    recorded.modelCentroid = { x: 0, y: 12.5, z: 10 };

    renderApp();

    // The nav marker appears at pointPairs[0] = (0,0) and the surface
    // camera is set to a FIRST-PERSON pose: eye height above that
    // world point on the mapped storey, looking horizontally along the
    // marker bearing (toward the centroid, +Z).
    const marker = await screen.findByTestId("linkview-nav-marker");
    expect(marker).toHaveAttribute("data-pdf-x", "0");
    expect(marker).toHaveAttribute("data-pdf-y", "0");
    // centroid (0,10) from world (0,0) → atan2(10, 0) = π/2 = 90°.
    expect(marker).toHaveAttribute("data-bearing-deg", "90.00");

    const seed = recorded.setViewPoseCalls[0];
    expect(seed).toBeDefined();
    expect(seed.animate).toBeFalsy();
    expect(seed.pose.isOrtho).toBe(false);
    expect(seed.pose.pos[0]).toBeCloseTo(0, 6);
    expect(seed.pose.pos[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(seed.pose.pos[2]).toBeCloseTo(0, 6);
    // Horizontal look toward +Z (bearing 90°).
    expect(seed.pose.target[0]).toBeCloseTo(0, 6);
    expect(seed.pose.target[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(seed.pose.target[2]).toBeGreaterThan(0);
  });

  it("a non-calibrated open (level plan) leaves no nav marker and no camera override", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);

    renderApp();

    await waitFor(() => {
      expect(recorded.openLevelCalls).toContain("Ground Floor");
    });
    expect(screen.queryByTestId("linkview-nav-marker")).not.toBeInTheDocument();
    expect(recorded.setViewPoseCalls.length).toBe(0);
  });

  it("dragging the nav marker teleports the first-person camera (PDF → world, eye height kept)", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    renderApp();

    const marker = await screen.findByTestId("linkview-nav-marker");

    // Give the marker's annotation layer a real client rect so
    // pageCoordsFromClientRect can project the drag (totalScale = 1 in
    // the mock → page coords = client coords).
    const layer = document.querySelector(
      '[data-pv-annotation-layer="true"]',
    ) as HTMLElement;
    Object.defineProperty(layer, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0,
        top: 0,
        width: 595,
        height: 842,
        x: 0,
        y: 0,
        right: 595,
        bottom: 842,
        toJSON: () => ({}),
      }),
    });

    act(() => {
      firePointer(marker, "pointerdown", { clientX: 0, clientY: 0 });
      firePointer(marker, "pointermove", { clientX: 100, clientY: 200 });
      firePointer(marker, "pointerup", { clientX: 100, clientY: 200 });
    });

    // identity calibration → world (100, 200); the camera teleports
    // there (instant), still at eye height, still looking horizontally.
    const dragCall =
      recorded.setViewPoseCalls[recorded.setViewPoseCalls.length - 1];
    expect(recorded.setViewPoseCalls.length).toBeGreaterThan(1);
    expect(dragCall.animate).toBe(false);
    expect(dragCall.pose.pos[0]).toBeCloseTo(100, 6);
    expect(dragCall.pose.pos[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(dragCall.pose.pos[2]).toBeCloseTo(200, 6);
    expect(dragCall.pose.target[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(
      Math.hypot(
        dragCall.pose.target[0] - 100,
        dragCall.pose.target[2] - 200,
      ),
    ).toBeCloseTo(1, 6);
  });

  it("wave 58 cold-load race: parks the seed until the surface loads, then seeds exactly once", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    const surfaceHandle = makeHandle(recorded);
    const viewerRef = { current: surfaceHandle as never };
    const registerHost = vi.fn();

    const { rerender } = render(
      <LinkviewApp
        viewerRef={viewerRef as never}
        registerHost={registerHost}
        surfaceLoaded={false}
      />,
    );

    // The marker appears (the marker side waits for pdfOverlay.onReady),
    // but the shared surface is still cold → no camera pose yet.
    const marker = await screen.findByTestId("linkview-nav-marker");
    expect(marker).toHaveAttribute("data-pdf-x", "0");
    expect(marker).toHaveAttribute("data-pdf-y", "0");
    expect(recorded.setViewPoseCalls.length).toBe(0);

    // The cold surface's default orbit camera must NOT drag the marker
    // off the calibration start point before the seed lands.
    act(() => {
      recorded.getPoseResult = {
        pos: [300, 80, 400],
        target: [0, 0, 0],
        fov: 45,
        isOrtho: false,
      };
      recorded.viewportRevision += 1;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(marker).toHaveAttribute("data-pdf-x", "0");
    expect(marker).toHaveAttribute("data-pdf-y", "0");

    // The shared surface finishes loading → the parked seed replays
    // exactly once.
    rerender(
      <LinkviewApp
        viewerRef={viewerRef as never}
        registerHost={registerHost}
        surfaceLoaded={true}
      />,
    );

    await waitFor(() => {
      expect(recorded.setViewPoseCalls.length).toBe(1);
    });
    const seed = recorded.setViewPoseCalls[0];
    expect(seed.animate).toBeFalsy();
    expect(seed.pose.pos[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(seed.pose.target[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
  });

  it("perf: live camera follow is gated on the viewport revision and reads poses silently", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    renderApp();
    const marker = await screen.findByTestId("linkview-nav-marker");

    // Camera at world (100, 200) looking toward +x (bearing 0°).
    act(() => {
      recorded.getPoseResult = {
        pos: [100, 62.5, 200],
        target: [110, 12.5, 200],
        fov: 45,
        isOrtho: false,
      };
      recorded.viewportRevision += 1;
    });
    // identity calibration → the marker follows to PDF (100, 200).
    await waitFor(() => {
      expect(marker).toHaveAttribute("data-pdf-x", "100");
      expect(marker).toHaveAttribute("data-pdf-y", "200");
      expect(marker).toHaveAttribute("data-bearing-deg", "0.00");
    });

    // Every per-frame read is silent (no "viewpoint save" breadcrumb).
    expect(recorded.getPoseOptions.length).toBeGreaterThan(0);
    for (const o of recorded.getPoseOptions) expect(o?.silent).toBe(true);

    // A still camera (same revision) → no further pose reads.
    const before = recorded.getPoseOptions.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(recorded.getPoseOptions.length).toBe(before);

    // A camera move bumps the revision → the marker follows again,
    // bearing included (camera now looks toward +z → 90°).
    act(() => {
      recorded.getPoseResult = {
        pos: [150, 62.5, 250],
        target: [150, 12.5, 260],
        fov: 45,
        isOrtho: false,
      };
      recorded.viewportRevision += 1;
    });
    await waitFor(() => {
      expect(marker).toHaveAttribute("data-pdf-x", "150");
      expect(marker).toHaveAttribute("data-pdf-y", "250");
      expect(marker).toHaveAttribute("data-bearing-deg", "90.00");
    });
  });

  it("first-person: locks the orbit controls, walks with WASD at eye height, ignores typing, releases on leave", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    recorded.liveCamera = true;
    recorded.modelCentroid = { x: 10, y: 12.5, z: 0 }; // bearing 0 (+X)

    const { unmount } = renderApp();
    const marker = await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.restrictedCalls).toBe(1));

    // Typing W into an input must not walk.
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }),
      );
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(recorded.navigateToCalls.length).toBe(0);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keyup", { code: "KeyW", bubbles: true }),
      );
    });
    input.remove();

    // W while the pointer is elsewhere on the page must not walk.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(recorded.navigateToCalls.length).toBe(0);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
    });

    // W with the pointer over the 3D pane walks forward (+X) at eye
    // height.
    const host = screen.getByTestId("mock-viewer-surface-host-slot");
    act(() => {
      host.dispatchEvent(new Event("pointerenter"));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
    });
    await waitFor(() =>
      expect(recorded.navigateToCalls.length).toBeGreaterThan(1),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
    });
    const last = recorded.navigateToCalls[recorded.navigateToCalls.length - 1];
    expect(last.eye.x).toBeGreaterThan(0);
    expect(last.eye.z).toBeCloseTo(0, 6);
    expect(last.eye.y).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(last.target.y).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    // Camera drives marker: the marker follows the walk on the PDF.
    await waitFor(() => {
      expect(Number(marker.getAttribute("data-pdf-x"))).toBeGreaterThan(0);
    });

    unmount();
    expect(recorded.releaseCalls).toBeGreaterThanOrEqual(1);
  });

  it("first-person: dragging on the 3D canvas turns the view (drag right = turn right)", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    recorded.liveCamera = true;
    recorded.modelCentroid = { x: 10, y: 12.5, z: 0 }; // bearing 0 (+X)

    renderApp();
    const marker = await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.restrictedCalls).toBe(1));

    const host = screen.getByTestId("mock-viewer-surface-host-slot");
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    act(() => {
      firePointer(canvas, "pointerdown", { clientX: 100, clientY: 100 });
      firePointer(canvas, "pointermove", { clientX: 150, clientY: 100 });
      firePointer(canvas, "pointerup", { clientX: 150, clientY: 100 });
    });

    expect(recorded.navigateToCalls.length).toBeGreaterThan(0);
    const last = recorded.navigateToCalls[recorded.navigateToCalls.length - 1];
    // Still at the seed point and eye height, now facing toward +Z.
    expect(last.eye.x).toBeCloseTo(0, 6);
    expect(last.eye.y).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    expect(last.target.z - last.eye.z).toBeGreaterThan(0);
    expect(last.target.y).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    // The marker cone follows the look azimuth.
    await waitFor(() => {
      expect(Number(marker.getAttribute("data-bearing-deg"))).toBeGreaterThan(0);
    });
  });

  it("first-person: switching to Overlap hands the orbit controls back", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    recorded.liveCamera = true;

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.restrictedCalls).toBe(1));
    expect(recorded.releaseCalls).toBe(0);

    fireEvent.click(screen.getByTestId("linkview-tools-overlap"));
    await waitFor(() => expect(recorded.releaseCalls).toBe(1));
  });

  it("perf: the left level-plan viewer stops rendering while the PDF covers it", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    renderApp();
    await screen.findByTestId("linkview-pdf-overlay");
    const left = screen
      .getByTestId("linkview-level-plan-viewer")
      .querySelector('[data-testid="mock-ifc-viewer"]');
    expect(left).toHaveAttribute("data-render-paused", "true");
  });

  it("perf: the left level-plan viewer renders while a model floor plan is shown", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground Floor", 0);
    await seedExtracted(building, ground.id);

    renderApp();
    await screen.findByTestId("linkview-plan-nav");
    const left = screen
      .getByTestId("linkview-level-plan-viewer")
      .querySelector('[data-testid="mock-ifc-viewer"]');
    expect(left).toHaveAttribute("data-render-paused", "false");
  });
});


describe("LinkviewApp — wave 63 review fixes", () => {
  beforeEach(async () => {
    resetSharedStore();
    window.localStorage.clear();
    if (!db.isOpen()) await db.open();
    await clearAllTables();
    clearRecordedCalls();
  });

  it("leaving LinkView restores the entry camera pose and drops the floor clip plane", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    // The Models route left the camera here.
    const modelsPose = {
      pos: [40, 30, 40],
      target: [0, 0, 0],
      fov: 45,
      isOrtho: false,
    };
    recorded.getPoseResult = { ...modelsPose };
    recorded.liveCamera = true;

    const { unmount } = renderApp();
    await screen.findByTestId("linkview-nav-marker");
    // The nav seed moved the camera to eye height.
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(1));
    fireEvent.click(screen.getByTestId("linkview-tools-overlap"));
    await waitFor(() => {
      expect(recorded.setFloorClipPlaneCalls).toContainEqual({
        enabled: true,
        floorZ: 12.5,
      });
    });

    recorded.setFloorClipPlaneCalls = [];
    recorded.setViewPoseCalls = [];
    unmount();

    expect(recorded.setFloorClipPlaneCalls).toContainEqual({
      enabled: false,
      floorZ: 0,
    });
    const restore = recorded.setViewPoseCalls[recorded.setViewPoseCalls.length - 1];
    expect(restore.pose.pos).toEqual(modelsPose.pos);
    expect(restore.pose.target).toEqual(modelsPose.target);
    expect(restore.animate).toBe(false);
  });

  it("switching between two calibrated PDFs keeps the nav marker and re-seeds", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const a = await seedPdf(building, "pdf-a", "A-101.pdf");
    const b = await seedPdf(building, "pdf-b", "B-101.pdf");
    await seedCalibration(a.file.id, first.name);
    await seedCalibration(b.file.id, first.name);

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(1));

    fireEvent.click(screen.getByTestId("linkview-tools-pdfs"));
    // Open B, then A: at least one of the two is a real switch
    // (whichever PDF the non-blank open picked first).
    fireEvent.click(await screen.findByTestId("linkview-pdf-row-B-101.pdf"));
    await new Promise((r) => setTimeout(r, 300));
    const afterB = recorded.setViewPoseCalls.length;
    fireEvent.click(screen.getByTestId("linkview-pdf-row-A-101.pdf"));
    await waitFor(() => {
      expect(recorded.setViewPoseCalls.length).toBeGreaterThan(afterB);
    });
    // The marker is portaled into the LIVE annotation layer.
    await waitFor(() => {
      const marker = screen.getByTestId("linkview-nav-marker");
      expect(marker.isConnected).toBe(true);
      expect(
        marker.closest('[data-pv-annotation-layer="true"]'),
      ).not.toBeNull();
    });
  });

  it("Overlap → Split re-seeds the first-person camera and re-locks the controls", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "101 FIRST FLOOR", 12.5);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    recorded.liveCamera = true;

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.restrictedCalls).toBe(1));
    expect(recorded.setViewPoseCalls.length).toBe(1);

    fireEvent.click(screen.getByTestId("linkview-tools-overlap"));
    await waitFor(() => expect(recorded.releaseCalls).toBe(1));
    // Entering overlap frames the page from straight above (it used to keep the
    // first-person eye pose: a grazing view of the plan plane).
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(2));
    const overlapPose = recorded.setViewPoseCalls[1].pose;
    expect(overlapPose.pos[1]).toBeGreaterThan(12.5 + 5);
    expect(overlapPose.target[1]).toBeCloseTo(12.5, 6);
    expect(Math.abs(overlapPose.pos[0] - overlapPose.target[0])).toBeLessThan(0.1);
    expect(recorded.setViewPoseCalls[1].animate).toBe(false);
    // Overlap moved the camera somewhere else.
    act(() => {
      recorded.getPoseResult = {
        pos: [300, 80, 400],
        target: [0, 0, 0],
        fov: 45,
        isOrtho: false,
      };
      recorded.viewportRevision += 1;
    });

    fireEvent.click(screen.getByTestId("linkview-tools-split"));
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(3));
    const reseed = recorded.setViewPoseCalls[2];
    expect(reseed.pose.pos[1]).toBeCloseTo(12.5 + EYE_HEIGHT, 6);
    await waitFor(() => expect(recorded.restrictedCalls).toBe(2));
  });

  it("millimetre model: the eye height sits on the floor in metres", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    await seedStorey(building, "st-ground", "Ground", 0);
    const first = await seedStorey(building, "st-first", "First", 3500);
    await seedStorey(building, "st-second", "Second", 7000);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(1));
    expect(recorded.setViewPoseCalls[0].pose.pos[1]).toBeCloseTo(
      3.5 + EYE_HEIGHT,
      6,
    );
  });

  it("a PDF calibrated on two storeys shows a storey chooser that re-seeds on change", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const ground = await seedStorey(building, "st-ground", "Ground", 0);
    const first = await seedStorey(building, "st-first", "First", 4);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);
    await seedCalibration(file.id, ground.name);

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    const select = (await screen.findByTestId(
      "linkview-cal-storey-select",
    )) as HTMLSelectElement;
    // Deterministic default: the lowest calibrated storey.
    expect(select.value).toBe("Ground");
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      "Ground",
      "First",
    ]);
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(1));
    expect(recorded.setViewPoseCalls[0].pose.pos[1]).toBeCloseTo(EYE_HEIGHT, 6);

    fireEvent.change(select, { target: { value: "First" } });
    await waitFor(() => expect(recorded.setViewPoseCalls.length).toBe(2));
    expect(recorded.setViewPoseCalls[1].pose.pos[1]).toBeCloseTo(
      4 + EYE_HEIGHT,
      6,
    );
  });

  it("no storey chooser for a PDF with a single calibration", async () => {
    const building = await seedBuilding("b-torre-a", "Torre A");
    const first = await seedStorey(building, "st-first", "First", 4);
    const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
    await seedCalibration(file.id, first.name);

    renderApp();
    await screen.findByTestId("linkview-nav-marker");
    expect(
      screen.queryByTestId("linkview-cal-storey-picker"),
    ).not.toBeInTheDocument();
  });

  it("touch: on-screen forward button walks the first-person camera", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const building = await seedBuilding("b-torre-a", "Torre A");
      const first = await seedStorey(building, "st-first", "First", 4);
      const { file } = await seedPdf(building, "pdf-s101", "S-101.pdf");
      await seedCalibration(file.id, first.name);
      recorded.liveCamera = true;
      recorded.modelCentroid = { x: 10, y: 4, z: 0 }; // bearing 0 (+X)

      renderApp();
      const forward = await screen.findByTestId("linkview-walk-forward");
      act(() => {
        forward.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      });
      await waitFor(() =>
        expect(recorded.navigateToCalls.length).toBeGreaterThan(1),
      );
      act(() => {
        forward.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      });
      const last = recorded.navigateToCalls[recorded.navigateToCalls.length - 1];
      expect(last.eye.x).toBeGreaterThan(0);
      expect(last.eye.y).toBeCloseTo(4 + EYE_HEIGHT, 6);
    } finally {
      window.matchMedia = original;
    }
  });
});
