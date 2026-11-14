// __tests__/calibration/MappingView.test.tsx
//
// Component tests for <MappingView>. We mock the heavy
// dependencies (PdfOverlay, IfcViewer, calibrations CRUD) so
// the test focuses on the wizard's wiring:
//   - Split layout (50/50 with status bar at top)
//   - State machine dispatch from PDF click
//   - State machine dispatch from 3D click
//   - Status bar shows the current step label
//   - Cancel / Save buttons

import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type ReactElement } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";
import { ViewerHandleProvider } from "@ff/viewer-react";
import { useViewerStore } from "@store/useViewerStore";

import { resetDb } from "../db/helpers";

// We mock the two heavy children so MappingView can mount in
// jsdom without pulling in PDF.js, OBC, or WebGL. Each test
// asserts the props passed down, which is the integration
// surface the wizard depends on.
// Hoisted so vi.mock factories (which run before top-level const declarations)
// can reference these spies. Without vi.hoisted, vitest errors with
// "There was an error when mocking a module... make sure there are no top
// level variables inside, since this call is hoisted to top of the file".
const { pdfOnClickSpy, ifcHandleMock } = vi.hoisted(() => {
  // Task 20: hoist the shared handle mock so the
  // vi.mock("@ff/viewer-react") factory below can reference it
  // (vi.mock factories are hoisted above top-level declarations).
  const pickWorldPoint = vi.fn();
  return {
    pdfOnClickSpy: vi.fn(),
    ifcHandleMock: {
      pickWorldPoint,
      worldToScreen: vi.fn(),
      openLevel: vi.fn(),
      closeLevel: vi.fn(),
      update: vi.fn(async () => undefined),
      getContainer: vi.fn(() => null as HTMLDivElement | null),
      get loadedModelIds() {
        return new Set<string>();
      },
    },
  };
});

// Task 15: MappingView no longer mounts its own <IfcViewer>.
// The handle is provided by the parent's ViewerHandleContext,
// and the test sets the ref's current to the mock directly
// (see `withProviders` below). The IfcViewer module still
// needs a default export for the `viewerRef.current.getContainer()`
// call inside MappingView's portal (typed as
// IfcViewerHandle). We mock it as a no-op component so any
// stray import doesn't blow up; nothing in the test renders
// the mock IfcViewer anymore.
//
// CONSOLIDATED mock — vi.mock() factories for the same path
// compose in source order, but only the LAST factory's return
// value is what the consumer sees. We therefore use ONE factory
// that exports everything the test needs: IfcViewer (no-op),
// PdfOverlay (stub capturing onPdfClick), ViewerHandleProvider
// (passthrough so consumer-side context works).
vi.mock("@ff/viewer-react", () => ({
  IfcViewer: () => null,
  PdfOverlay: (props: {
    pdfVersionId: string;
    captureClicks?: boolean;
    onPdfClick?: (coords: { x: number; y: number }) => void;
  }) => {
    // Capture the latest onPdfClick so tests can invoke it.
    pdfOnClickSpy(props);
    return (
      <div
        data-testid="mock-pdf-overlay"
        data-pdf-version-id={props.pdfVersionId}
        data-capture-clicks={props.captureClicks ? "true" : "false"}
        onClick={() => props.onPdfClick?.({ x: 100, y: 200 })}
      />
    );
  },
  ViewerHandleProvider: ({ children }: { children: React.ReactNode }) => children,
  useViewerHandle: () => ({ current: ifcHandleMock }),
}));

// Mock the calibration CRUD so the Save handler doesn't try
// to talk to Dexie. We just verify it's called.
const { createCalibrationSpy, getCalibrationForPdfAndStoreySpy, updateCalibrationSpy } = vi.hoisted(() => ({
  createCalibrationSpy: vi.fn(),
  getCalibrationForPdfAndStoreySpy: vi.fn(async () => undefined),
  updateCalibrationSpy: vi.fn(),
}));
vi.mock("@ff/data/db/tables/calibrations", () => ({
  createCalibration: (...args: unknown[]) => {
    createCalibrationSpy(...args);
    const input = (args[0] ?? {}) as {
      projectId?: string;
      pdfFileId?: string;
      storeyName?: string;
      pointPairs?: unknown;
      transformParams?: unknown;
      confidence?: number;
    };
    return Promise.resolve({
      id: "new-id",
      projectId: input.projectId,
      pdfFileId: input.pdfFileId,
      storeyName: input.storeyName,
      pointPairs: input.pointPairs,
      transformParams: input.transformParams,
      confidence: input.confidence,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
  getCalibrationForPdfAndStorey: () => getCalibrationForPdfAndStoreySpy(),
  updateCalibration: (...args: unknown[]) => updateCalibrationSpy(...args),
}));

vi.mock("@ff/data/db/tables/pdfFiles", () => ({
  getPdfFile: async (id: string) =>
    id === "pdf-1" ? { id, buildingId: "b-1", name: "Planta.pdf", createdAt: 0, updatedAt: 0 } : undefined,
}));

vi.mock("@ff/data/db/tables/pdfVersions", () => ({
  getLatestPdfVersion: async () => ({
    id: "v-latest",
    pdfFileId: "pdf-1",
    versionNumber: 1,
    name: "Planta.pdf",
    size: 1,
    contentHash: "h",
    pageCount: 1,
    width: 612,
    height: 792,
    storedAt: 0,
    blobKey: "k",
    isLatest: true,
  }),
  // Task 20 §1.8.3 + audit #7: PdfOverlay now also calls
  // getPdfVersion(id) (single-version lookup) — the mock must
  // expose it too. Returns a null-on-miss signature per the
  // post-audit type normalization (Promise<PdfVersionRecord | null>).
  getPdfVersion: async (id: string) =>
    id === "v-latest"
      ? {
          id: "v-latest",
          pdfFileId: "pdf-1",
          versionNumber: 1,
          name: "Planta.pdf",
          size: 1,
          contentHash: "h",
          pageCount: 1,
          width: 612,
          height: 792,
          storedAt: 0,
          blobKey: "k",
          isLatest: true,
        }
      : null,
}));

// Wave 63: the calibration is written under the ACTIVE project id.
const authMock = vi.hoisted(() => ({ projectId: "proj-active" as string | undefined }));
vi.mock("@ff/auth", () => ({
  useProjectId: () => authMock.projectId,
  // Mirrors the real hook: no project -> throw, never a fallback id.
  useRequiredProjectId: () => {
    if (!authMock.projectId) throw new Error("NoActiveProjectError");
    return authMock.projectId;
  },
}));

// Import after mocks.
const { default: MappingView } = await import("@calibration/MappingView");

function withProviders(ui: ReactElement): ReactElement {
  // Task 15: the test now sets the ref's current directly to
  // the mock handle, because MappingView no longer mounts an
  // <IfcViewer> that would have set it. The ref is created
  // here, populated with the mock, and threaded into the
  // ViewerHandleProvider. The cast through `unknown` is
  // needed because `RefObject<T>` types `current` as readonly
  // — the runtime accepts the assignment, but the type
  // doesn't. The ViewerHandleProvider itself only reads the
  // value, so this is safe.
  const ref = createRef<IfcViewerHandle>();
  (ref as unknown as { current: IfcViewerHandle | null }).current =
    ifcHandleMock as unknown as IfcViewerHandle;
  return <ViewerHandleProvider viewerRef={ref}>{ui}</ViewerHandleProvider>;
}

describe("<MappingView>", () => {
  beforeEach(async () => {
    await resetDb("MappingView");
    pdfOnClickSpy.mockClear();
    ifcHandleMock.pickWorldPoint.mockReset();
    ifcHandleMock.worldToScreen.mockReset();
    createCalibrationSpy.mockClear();
    updateCalibrationSpy.mockClear();
    getCalibrationForPdfAndStoreySpy.mockClear();
    useViewerStore.setState({
      calibrationFlow: null,
      activePdfVersionId: null,
      activeStoreyName: null,
    });
  });

  it("renders nothing when calibrationFlow is null (defensive)", () => {
    const { container } = render(withProviders(<MappingView />));
    expect(container.firstChild).toBeNull();
  });

  it("renders the split layout + status bar when a flow is active", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    render(withProviders(<MappingView />));
    expect(screen.getByTestId("mapping-view")).toBeTruthy();
    expect(screen.getByTestId("mapping-view-status")).toBeTruthy();
    expect(screen.getByTestId("mapping-view-pdf-pane")).toBeTruthy();
    expect(screen.getByTestId("mapping-view-world-pane")).toBeTruthy();
  });

  it("shows the current step label in the status bar", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    render(withProviders(<MappingView />));
    const label = screen.getByTestId("mapping-view-step-label");
    expect(label.textContent).toMatch(/Pick point A in the PDF/);
  });

  it("forwards the onPdfClick prop to PdfOverlay and dispatches SET_PDF_PICK", async () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    render(withProviders(<MappingView />));
    // Wait for the (mocked) PdfOverlay to render.
    const pdf = await screen.findByTestId("mock-pdf-overlay");
    fireEvent.click(pdf);
    // The reducer advanced: step is now PICK_PDF_B.
    await waitFor(() => {
      expect(useViewerStore.getState().calibrationFlow?.step).toBe(
        "PICK_PDF_B",
      );
    });
  });

  it("dispatches SET_WORLD_PICK when the 3D pane is clicked in PICK_WORLD_A", async () => {
    // Start the wizard and walk it to PICK_WORLD_A.
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    const s = useViewerStore.getState();
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: { x: 0, y: 0 } });
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: { x: 1, y: 1 } });
    // We're in PICK_WORLD_A now.
    ifcHandleMock.pickWorldPoint.mockResolvedValue({ x: 3, y: 0, z: 4 });
    render(withProviders(<MappingView />));
    const worldPane = await screen.findByTestId("mapping-view-world-pane");
    fireEvent.click(worldPane);
    await waitFor(() => {
      expect(useViewerStore.getState().calibrationFlow?.step).toBe(
        "PICK_WORLD_B",
      );
    });
    expect(useViewerStore.getState().calibrationFlow?.worldA).toEqual({
      x: 3,
      z: 4,
    });
  });

  it("Save is disabled outside REVIEW", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    render(withProviders(<MappingView />));
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("Save is enabled in REVIEW, calls createCalibration + MARK_SAVED, and closes the wizard", async () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    const s = useViewerStore.getState();
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: { x: 0, y: 0 } });
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: { x: 100, y: 100 } });
    s.dispatchCalibrationAction({ type: "SET_WORLD_PICK", point: { x: 0, z: 0 } });
    s.dispatchCalibrationAction({ type: "SET_WORLD_PICK", point: { x: 10, z: 10 } });
    render(withProviders(<MappingView />));
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    // The DB write happens first, then the wizard closes by
    // dispatching MARK_SAVED + cancelCalibration. Maintainer: the
    // user must be back in the 3D view after Save — verify
    // the flow is cleared.
    await waitFor(() => {
      expect(createCalibrationSpy).toHaveBeenCalled();
    });
    expect(createCalibrationSpy.mock.calls[0][0]).toMatchObject({
      projectId: "proj-active",
    });
    await waitFor(() => {
      expect(useViewerStore.getState().calibrationFlow).toBeNull();
    });
  });

  function walkToReview(
    pdfB: { x: number; y: number } = { x: 100, y: 100 },
    worldB: { x: number; z: number } = { x: 10, z: 10 },
  ): void {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    const s = useViewerStore.getState();
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: { x: 0, y: 0 } });
    s.dispatchCalibrationAction({ type: "SET_PDF_PICK", point: pdfB });
    s.dispatchCalibrationAction({ type: "SET_WORLD_PICK", point: { x: 0, z: 0 } });
    s.dispatchCalibrationAction({ type: "SET_WORLD_PICK", point: worldB });
  }

  it("has no default-project fallback: with no project it throws and writes nothing", () => {
    authMock.projectId = undefined;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      walkToReview();
      expect(() => render(withProviders(<MappingView />))).toThrow(/NoActiveProject/);
      expect(createCalibrationSpy).not.toHaveBeenCalled();
      expect(updateCalibrationSpy).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      authMock.projectId = "proj-active";
    }
  });

  it("disables Save and explains when the two PDF picks are too close", () => {
    walkToReview({ x: 2, y: 2 });
    render(withProviders(<MappingView />));
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("mapping-view-error").textContent).toMatch(/PDF points/);
  });

  it("disables Save when the two 3D picks are too close", () => {
    walkToReview({ x: 100, y: 100 }, { x: 0.05, z: 0.05 });
    render(withProviders(<MappingView />));
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("mapping-view-error").textContent).toMatch(/3D points/);
  });

  it("a double click writes only once", async () => {
    walkToReview();
    let release: () => void = () => undefined;
    getCalibrationForPdfAndStoreySpy.mockImplementationOnce(
      () => new Promise<undefined>((r) => { release = () => r(undefined); }),
    );
    render(withProviders(<MappingView />));
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(save.textContent).toBe("Saving…"));
    expect(save.disabled).toBe(true);
    release();
    await waitFor(() => expect(useViewerStore.getState().calibrationFlow).toBeNull());
    expect(getCalibrationForPdfAndStoreySpy).toHaveBeenCalledTimes(1);
    expect(createCalibrationSpy).toHaveBeenCalledTimes(1);
  });

  it("shows a failed write inline and keeps the wizard open", async () => {
    walkToReview();
    getCalibrationForPdfAndStoreySpy.mockImplementationOnce(async () => {
      throw new Error("QuotaExceededError");
    });
    render(withProviders(<MappingView />));
    fireEvent.click(screen.getByTestId("mapping-view-save"));
    await waitFor(() =>
      expect(screen.getByTestId("mapping-view-error").textContent).toMatch(/QuotaExceededError/),
    );
    expect(createCalibrationSpy).not.toHaveBeenCalled();
    expect(useViewerStore.getState().calibrationFlow?.step).toBe("REVIEW");
    const save = screen.getByTestId("mapping-view-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
  });

  it("Cancel dispatches cancelCalibration (clears the flow)", () => {
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    render(withProviders(<MappingView />));
    const cancel = screen.getByTestId("mapping-view-cancel");
    fireEvent.click(cancel);
    expect(useViewerStore.getState().calibrationFlow).toBeNull();
  });
});
