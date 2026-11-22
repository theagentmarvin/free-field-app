// __tests__/components/MappedStoreysSection.test.tsx
//
// Component tests for <MappedStoreysSection>: header + count badge,
// per-row name + elevation, empty-state message, no-render under
// null buildingId, sort by elevation ascending, plus the click-to-
// open and click-active-to-close behavior wired through the
// ViewerHandleContext in Task 6.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRef,
  type MutableRefObject,
  type RefObject,
  type ReactElement,
} from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import MappedStoreysSection from "@components/MappedStoreysSection";
import { ViewerHandleProvider } from "@ff/viewer-react";
import type { IfcViewerHandle } from "@ff/viewer-react";
import { useViewerStore } from "@store/useViewerStore";
import { db } from "@ff/data/db/database";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { createStorey, createStoreys } from "@ff/data/db/tables/storeys";
import { setExtracted } from "@ff/data/db/tables/extractedStoreys";

import { resetDb } from "../db/helpers";

async function makeContext() {
  const p = await createProject({ name: "MappedSection", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  const f = await createIfcFile({
    buildingId: b.id,
    name: "model.ifc",
    currentVersionId: "placeholder",
  });
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 0,
    isLatest: true,
  });
  await db.ifcFiles.update(f.id, { currentVersionId: v.id });
  return { project: p, building: b, file: f, version: v };
}

interface MockHandle extends IfcViewerHandle {
  openLevel: ReturnType<typeof vi.fn>;
  closeLevel: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  pickWorldPoint: ReturnType<typeof vi.fn>;
  // Task 18: tool switching. The mock is a no-op — the test
  // doesn't exercise the click→click state machine; it just
  // needs the interface to satisfy the IfcViewerHandle type.
  setActiveTool: ReturnType<typeof vi.fn>;
  activeTool: "navigation" | "measure" | null;
}

function makeMockHandle(
  ref: MutableRefObject<IfcViewerHandle | null>,
  overrides: Partial<MockHandle> = {},
): MockHandle {
  // Defaults: openLevel returns Promise<true>, closeLevel
  // is a no-op. Tests can override behavior per-case.
  const openLevel = vi.fn((_name: string) => Promise.resolve(true));
  const closeLevel = vi.fn();
  const update = vi.fn(async () => undefined);
  // pickWorldPoint: Task 12a Part 1 added this to IfcViewerHandle.
  // MappedStoreysSection doesn't trigger it; the default is
  // a no-op returning null. Wizard (Part 2) will call it.
  const pickWorldPoint = vi.fn(async () => null);
  // worldToScreen: Task 12a Part 2. The default is a no-op
  // returning null; tests that care can override per-case.
  const worldToScreen = vi.fn(
    (_p: { x: number; y: number; z: number }) => null,
  );
  // Task 15: getContainer is used by MappingView to portal the
  // 3D line SVG into the IfcViewer's DOM. The mock returns
  // null (no container) because MappedStoreysSection doesn't
  // exercise the wizard's SVG portal — we just need the
  // interface to satisfy the IfcViewerHandle type.
  const getContainer = vi.fn(() => null as HTMLDivElement | null);
  const handle: MockHandle = {
    get loadedModelIds() {
      return new Set<string>();
    },
    openLevel,
    closeLevel,
    update,
    pickWorldPoint,
    worldToScreen,
    getViewportRevision: vi.fn(() => 0),
    getContainer,
    zoom: vi.fn(),
    setActiveTool: vi.fn(),
    setMemoryPressure: vi.fn(),
    activeTool: null,
    // Task 19/21: no-ops for methods not exercised by
    // MappedStoreysSection tests (the section only uses
    // openLevel / closeLevel / update). Added to satisfy
    // the IfcViewerHandle interface.
    setElementVisibility: vi.fn(),
    setOnElementPick: vi.fn(),
    selectElement: vi.fn(),
    clearSelection: vi.fn(),
    getSelection: vi.fn(() => new Map()),
    onSelectionChange: vi.fn(),
    onLoadedModelsChange: vi.fn(),
    // Wave 31: getModelVersionKey became a required IfcViewerHandle
    // member (hot-swap identity). Not exercised here — no-op per the
    // same precedent as the other interface-satisfying stubs.
    getModelVersionKey: vi.fn((_modelId: string) => null),
    getElementData: vi.fn(async () => null),
    // Task 22: getAllModelExpressIds is now async (it calls
    // `model.getItemsIdsWithGeometry()` internally). The mock
    // returns a resolved Promise of an empty Map so the test
    // surface stays the same.
    getAllModelExpressIds: vi.fn(async () => new Map()),
    // Task 23: getPropertyDataForModel is the new batched
    // `getItemsData` wrapper that powers the in-memory inverted
    // index. The mock returns a resolved Promise of `null` (no
    // data) so the test surface stays the same — the index hook
    // treats `null` as "no index for this model" and continues.
    getPropertyDataForModel: vi.fn(async () => null),
    getModelLevelLocalIds: vi.fn(async () => null),
    getActiveStoreyFloorZ: vi.fn(() => null),
    getModelCentroid: vi.fn(() => null),
    // Wave 58: getLevelPlanDistance (the level-plan framing height,
    // required on IfcViewerHandle) — not exercised by
    // MappedStoreysSection; explicit stub keeps the mock assignable.
    getLevelPlanDistance: vi.fn(() => 50),
    setRestrictedThirdPerson: vi.fn(),
    releaseRestrictedCamera: vi.fn(),
    // Task 21 (LinkView third-person nav): navigateTo and
    // unprojectToFloorPlane were added to IfcViewerHandle after
    // this mock was last touched. MappedStoreysSection doesn't
    // exercise either — no-op stubs keep the mock assignable to
    // the full interface.
    navigateTo: vi.fn(),
    unprojectToFloorPlane: vi.fn(() => null),
    // Task 23: addFloorPlanPlane / removeFloorPlanPlane and the floor
    // clip setter became required on IfcViewerHandle. MappedStoreysSection
    // never calls them — no-op stubs keep the mock assignable to the
    // full interface (the `...overrides` spread alone would make them
    // optional and TS rejects that).
    addFloorPlanPlane: vi.fn(
      (
        _canvas: HTMLCanvasElement,
        _worldBounds: { minX: number; minZ: number; maxX: number; maxZ: number },
        _elevation: number,
      ) => "mock-plane",
    ),
    removeFloorPlanPlane: vi.fn(),
    setFloorClipPlane: vi.fn(),
    // Task 24: resetCameraToDefault became a required IfcViewerHandle
    // member (floor-plan → navigate cleanup). Not exercised here — the
    // explicit no-op keeps the object literal assignable to MockHandle
    // (`...overrides` alone would type it optional and TS rejects that).
    resetCameraToDefault: vi.fn(),
    // Wave 55: fitLevelPlan (re-frame the open level plan — the plan
    // nav cluster's Fit button) became required on IfcViewerHandle.
    // Not exercised here — explicit stub per the same precedent.
    fitLevelPlan: vi.fn(async () => true),
    // Tasks module (Day 2): getPose/setViewPose became required on
    // IfcViewerHandle (pose capture/restore for task pins). Not
    // exercised by MappedStoreysSection — no-op stubs per the same
    // precedent above (the `...overrides` spread would type them
    // optional and TS rejects that).
    getPose: vi.fn(() => null),
    setViewPose: vi.fn(),
    // Wave 5B: getSelectionWorldCenter (compact bbox-centre anchor
    // for the tap-to-create + marker) became required on
    // IfcViewerHandle. Not exercised here — no-op stub per the same
    // precedent as getPose/setViewPose.
    getSelectionWorldCenter: vi.fn(async () => null),
    getSelectionWorldPoint: vi.fn(() => null),
    // Wave 48: face-normal getter added to IfcViewerHandle for the
    // context toolbar's section plane. MappedStoreysSection never
    // calls it; no-op null keeps the mock assignable.
    getSelectionWorldNormal: vi.fn(() => null),
    isSelectionPointPending: vi.fn(() => false),
    // Day-3: getSnapshot (same-frame WebGL capture for the location
    // thumb) became required on IfcViewerHandle. Not exercised here —
    // session test surface never has a real renderer, so the null
    // fallback is the correct no-op stub.
    getSnapshot: vi.fn(() => null),
    // Wave 12: 3D measurement tool mode. Not exercised by
    // MappedStoreysSection — no-op stubs satisfy the extended
    // IfcViewerHandle interface (same precedent as getPose / getSnapshot).
    setMeasureMode: vi.fn(),
    clearMeasurements: vi.fn(),
    onMeasureReadout: vi.fn(),
    // Wave 50: two-stage measure Escape surface. Not exercised by
    // MappedStoreysSection — no-op stubs satisfy the extended
    // IfcViewerHandle interface.
    isMeasureInProgress: vi.fn(() => false),
    cancelMeasureCreation: vi.fn(),
    // Wave 13: 3D section planes. Not exercised by
    // MappedStoreysSection — no-op stubs satisfy the extended
    // IfcViewerHandle interface (same precedent as getPose / getSnapshot).
    addSectionPlane: vi.fn(() => true),
    flipLastSectionPlane: vi.fn(),
    clearSectionPlanes: vi.fn(),
    getSectionPlaneCount: vi.fn(() => 0),
    getSectionPlanes: vi.fn(() => []),
    ...overrides,
  };
  ref.current = handle;
  return handle;
}

/**
 * Renders <MappedStoreysSection> inside a <ViewerHandleProvider>
 * that exposes a mock viewer handle. Returns the ref + the mock
 * so the test can read call counts.
 */
function renderWithMockHandle(
  buildingId: string | null,
  overrides: Partial<MockHandle> = {},
) {
  // We need a mutable ref so we can pre-set `current` with our
  // mock handle. The context's `RefObject<IfcViewerHandle>` shape
  // is satisfied at the type level by the cast; the runtime ref
  // is what the provider will pass to its consumers.
  const ref = createRef<IfcViewerHandle>() as unknown as MutableRefObject<
    IfcViewerHandle | null
  >;
  const mock = makeMockHandle(ref, overrides);
  const ui: ReactElement = (
    <ViewerHandleProvider viewerRef={ref as unknown as RefObject<IfcViewerHandle>}>
      <MappedStoreysSection buildingId={buildingId} />
    </ViewerHandleProvider>
  );
  const view = render(ui);
  return { ref, mock, ...view };
}

describe("<MappedStoreysSection>", () => {
  beforeEach(async () => {
    await resetDb("MappedStoreysSection");
    // Reset the active view store between tests so a prior test's
    // `setActiveStoreyName` doesn't leak.
    useViewerStore.getState().setActiveStoreyName(null);
  });

  it("renders the header 'Mapped' with the count badge", async () => {
    const { building, file, version } = await makeContext();
    const s1 = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "A",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const s2 = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "B",
      elevation: 1,
      expressId: 2,
      height: null,
    });
    await setExtracted(building.id, s1.id, true);
    await setExtracted(building.id, s2.id, true);

    renderWithMockHandle(building.id);
    // The hook reads the live query asynchronously; wait for the
    // badge count to flip from 0 to 2 before asserting.
    await waitFor(() => {
      const root = screen.getByTestId("mapped-section");
      expect(root.getAttribute("data-mapped-count")).toBe("2");
    });
    const root = screen.getByTestId("mapped-section");
    expect(within(root).getByText("Mapped")).toBeInTheDocument();
    expect(within(root).getByText("2")).toBeInTheDocument();
  });

  it("renders a row per mapped storey with name and elevation", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Roof",
      elevation: 12.5,
      expressId: 1,
      height: null,
    });
    await setExtracted(building.id, s.id, true);

    renderWithMockHandle(building.id);
    const root = await screen.findByTestId("mapped-section");
    // Wait for the live query to deliver the row.
    await waitFor(() => {
      expect(root.getAttribute("data-mapped-count")).toBe("1");
    });
    expect(within(root).getByText("Roof")).toBeInTheDocument();
    expect(within(root).getByText("z=12.50")).toBeInTheDocument();
  });

  it("renders the empty-state message when no levels are mapped", async () => {
    const { building } = await makeContext();
    renderWithMockHandle(building.id);
    const empty = await screen.findByTestId("mapped-section-empty");
    expect(empty).toHaveTextContent(
      "No levels mapped yet. Click 'Get Levels' to extract.",
    );
  });

  it("renders nothing when buildingId is null", () => {
    const { container } = renderWithMockHandle(null);
    expect(screen.queryByTestId("mapped-section")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("sorts rows by elevation ascending", async () => {
    const { building, file, version } = await makeContext();
    const [mid, low, high] = await createStoreys([
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "Mid",
        elevation: 5,
        expressId: 1,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "Low",
        elevation: 1,
        expressId: 2,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "High",
        elevation: 10,
        expressId: 3,
        height: null,
      },
    ]);
    await setExtracted(building.id, mid.id, true);
    await setExtracted(building.id, low.id, true);
    await setExtracted(building.id, high.id, true);

    renderWithMockHandle(building.id);
    const root = await screen.findByTestId("mapped-section");
    await waitFor(() => {
      expect(
        within(root).getAllByTestId("mapped-section-row"),
      ).toHaveLength(3);
    });
    const rows = within(root).getAllByTestId("mapped-section-row");
    const namesInOrder = rows.map((r) => r.textContent ?? "");
    const lowIdx = namesInOrder.findIndex((t) => t.includes("Low"));
    const midIdx = namesInOrder.findIndex((t) => t.includes("Mid"));
    const highIdx = namesInOrder.findIndex((t) => t.includes("High"));
    expect(lowIdx).toBe(0);
    expect(midIdx).toBe(1);
    expect(highIdx).toBe(2);
  });

  // ---------- Task 6: click-to-open behavior ----------

  it("a row click calls openLevel with the storey name", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "101 FIRST FLOOR",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    await setExtracted(building.id, s.id, true);

    const { mock } = renderWithMockHandle(building.id);
    const row = await screen.findByTestId("mapped-section-row");
    fireEvent.click(row);
    expect(mock.openLevel).toHaveBeenCalledTimes(1);
    expect(mock.openLevel).toHaveBeenCalledWith("101 FIRST FLOOR");
    expect(mock.closeLevel).not.toHaveBeenCalled();
  });

  it("clicking the active row calls closeLevel instead", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "101 FIRST FLOOR",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    await setExtracted(building.id, s.id, true);

    // Pre-set the store so the row is "active" on first render.
    useViewerStore.getState().setActiveStoreyName("101 FIRST FLOOR");

    const { mock } = renderWithMockHandle(building.id);
    const row = await screen.findByTestId("mapped-section-row");
    fireEvent.click(row);
    expect(mock.closeLevel).toHaveBeenCalledTimes(1);
    expect(mock.openLevel).not.toHaveBeenCalled();
  });

  it("the active row has data-active='true' and others do not", async () => {
    const { building, file, version } = await makeContext();
    const [low, high] = await createStoreys([
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "LOW",
        elevation: 0,
        expressId: 1,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "HIGH",
        elevation: 5,
        expressId: 2,
        height: null,
      },
    ]);
    await setExtracted(building.id, low.id, true);
    await setExtracted(building.id, high.id, true);

    // "HIGH" is the active view.
    useViewerStore.getState().setActiveStoreyName("HIGH");

    renderWithMockHandle(building.id);
    const root = await screen.findByTestId("mapped-section");
    await waitFor(() => {
      expect(root.getAttribute("data-mapped-count")).toBe("2");
    });
    const rows = within(root).getAllByTestId("mapped-section-row");
    expect(rows).toHaveLength(2);
    const lowRow = rows.find((r) => r.textContent?.includes("LOW"));
    const highRow = rows.find((r) => r.textContent?.includes("HIGH"));
    expect(lowRow).toBeDefined();
    expect(highRow).toBeDefined();
    expect(lowRow!.getAttribute("data-active")).toBeNull();
    expect(highRow!.getAttribute("data-active")).toBe("true");
  });

  it("click when openLevel returns false logs a warning and does not throw", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "GONE",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    await setExtracted(building.id, s.id, true);

    // Mock openLevel to return false (view not found).
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    renderWithMockHandle(building.id, {
      openLevel: vi.fn(() => false),
    });
    const row = await screen.findByTestId("mapped-section-row");
    // No unhandled error means the component must catch the
    // false return and warn instead of throwing.
    expect(() => fireEvent.click(row)).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) =>
      String(c[0]).includes("openLevel('GONE')"),
    )).toBe(true);

    warnSpy.mockRestore();
  });
});
