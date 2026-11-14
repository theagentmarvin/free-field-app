// __tests__/components/ViewerPanel.test.tsx
//
// Regression test for the 2026-06-03 Task 15 fix.
//
// Task 15 made the IfcViewer always-mounted and the
// MappingView / PdfOverlay into overlays on top of it. The
// first attempt rendered them as siblings WITHOUT an
// absolute-positioned wrapper, so the IfcViewer (first
// child, `position: relative; width: 100%; height: 100%`)
// pushed the overlays BELOW it in document flow. The
// wrapper's `overflow: hidden` clipped the result, so the
// PDF and the wizard were invisible — Maintainer reported
// "I can't open the PDF any longer" and "I can't Map".
//
// The fix: wrap the MappingView and the PdfOverlay in
// `position: absolute; inset: 0` containers (with the
// `data-testid`s this test asserts on). The test below
// fails if either overlay wrapper is missing in its
// respective state, locking in the regression.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";
import { ViewerHandleProvider } from "@ff/viewer-react";
import { useViewerStore } from "@store/useViewerStore";

import { resetDb } from "../db/helpers";

// We mock the heavy children so ViewerPanel can mount in
// jsdom without PDF.js / OBC / WebGL. The mocks just render
// identifiable stubs that the test queries by data-testid.
// Note: in vitest, when multiple vi.mock() calls target the
// same module path, the LATER call wins. Both factories must
// therefore export everything the consumer needs — including
// ViewerHandleProvider + IfcViewer + PdfOverlay, which ViewerPanel
// imports as named exports at the top. We use named keys (not
// `default:`) because the source uses `import { IfcViewer, ... }`.
// The test then switches between stubs based on which component
// the assertion queries for (data-testid="stub-ifc-viewer" vs
// "stub-pdf-overlay") — the LAST mock wins module-wide, but
// the test only checks one at a time per case.
vi.mock("@ff/viewer-react", () => ({
  IfcViewer: () => <div data-testid="stub-ifc-viewer" />,
  PdfOverlay: () => <div data-testid="stub-pdf-overlay" />,
  ViewerHandleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@ff/viewer-react", () => ({
  IfcViewer: () => <div data-testid="stub-ifc-viewer" />,
  PdfOverlay: (props: { pdfVersionId: string }) => (
    <div data-testid="stub-pdf-overlay" data-pdf-version-id={props.pdfVersionId} />
  ),
  ViewerHandleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@calibration/MappingView", () => ({
  default: () => <div data-testid="stub-mapping-view" />,
}));

vi.mock("@components/CompassGizmo", () => ({
  default: () => <div data-testid="stub-compass-gizmo" />,
}));

vi.mock("@components/EmptyViewerDropzone", () => ({
  default: () => <div data-testid="stub-empty-dropzone" />,
}));

// Post-@ff/data extraction (2026-07-12): useIfcFiles and
// useIfcPipeline used to live at separate module paths
// (@hooks/useIfcFiles, @hooks/useIfcPipeline) and were mocked with
// two independent vi.mock() calls. They now BOTH live in the
// @ff/data/hooks barrel, so a single factory must export all
// three symbols — otherwise the later vi.mock() wins and clobbers
// the earlier one (leaving useIfcFiles undefined).
vi.mock("@ff/data/hooks", () => ({
  useIfcFiles: () => [{ id: "f-1" }], // pretend the building has one IFC
  useIfcPipeline: () => ({
    loadIfc: vi.fn(),
    isLoading: false,
    registerFragments: vi.fn(),
  }),
  // Task 20 §1.8.3 + audit #3: getStoreysForBuilding is now
  // passed as a standalone function to <IfcViewer>. The mock
  // must expose it (audit #4: missing getStoreysForBuilding).
  getStoreysForBuilding: async () => [],
}));

// Import after mocks.
const { default: ViewerPanelImported } = await import("@components/ViewerPanel");

/** Render <ViewerPanel> inside the ViewerHandleProvider so
 *  `useViewerHandle()` doesn't throw in any descendant that
 *  might call it. The viewerRef is a stub — the test doesn't
 *  exercise the IfcViewer, just its presence in the DOM. */
function renderPanel(buildingId: string | null) {
  const ref = createRef<IfcViewerHandle>();
  // Wave 56-fix — the viewer-tools filter hooks (now mounted in
  // ViewerPanel) read these handle members; the stub must provide
  // them or useModelsToolFilter throws on `loadedModelIds.size`.
  const stubHandle = {
    loadedModelIds: new Set<string>(),
    onLoadedModelsChange: () => () => {},
    getAllModelExpressIds: async () => new Map<string, Set<number>>(),
    getModelLevelLocalIds: async () => new Set<number>(),
  } as unknown as IfcViewerHandle;
  (ref as unknown as { current: IfcViewerHandle | null }).current =
    stubHandle;
  return render(
    <ViewerHandleProvider viewerRef={ref}>
      <ViewerPanelImported
        projectId="p"
        buildingId={buildingId}
        viewerRef={ref}
      />
    </ViewerHandleProvider>,
  );
}

describe("<ViewerPanel> overlay structure (Task 15 regression)", () => {
  beforeEach(async () => {
    await resetDb("ViewerPanel-overlay");
    useViewerStore.setState({
      calibrationFlow: null,
      activePdfVersionId: null,
      activeStoreyName: null,
    });
  });

  it("renders the IfcViewer (no overlay) when hasIfc and nothing else is active", () => {
    renderPanel("b-1");
    expect(screen.getByTestId("stub-ifc-viewer")).toBeTruthy();
    expect(screen.queryByTestId("viewer-panel-pdf-overlay")).toBeNull();
    expect(screen.queryByTestId("viewer-panel-wizard-overlay")).toBeNull();
  });

  it("renders the PDF overlay wrapper when activePdfVersionId is set", () => {
    // Task 15 regression: the PDF overlay MUST be wrapped in a
    // position: absolute container so it sits ON TOP of the
    // IfcViewer, not below it. The wrapper carries the
    // data-testid 'viewer-panel-pdf-overlay'.
    useViewerStore.getState().setActivePdfVersionId("v-1");
    renderPanel("b-1");
    const wrapper = screen.queryByTestId("viewer-panel-pdf-overlay");
    expect(wrapper).not.toBeNull();
    // The IfcViewer is still in the DOM (it's always mounted
    // when hasIfc is true). The PDF overlay sits on top.
    expect(screen.getByTestId("stub-ifc-viewer")).toBeTruthy();
    expect(screen.getByTestId("stub-pdf-overlay")).toBeTruthy();
    // Verify the wrapper is absolutely positioned — this is the
    // CSS contract that fixes the "hidden behind IfcViewer"
    // regression.
    const style = (wrapper as HTMLElement).style;
    expect(style.position).toBe("absolute");
  });

  it("renders the wizard overlay wrapper when calibrationFlow is set", async () => {
    // Same regression for the wizard path. Without the
    // absolute wrapper, the MappingView would render BELOW the
    // IfcViewer and the user would see the 3D viewer with no
    // wizard on top.
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    renderPanel("b-1");
    const wrapper = screen.queryByTestId("viewer-panel-wizard-overlay");
    expect(wrapper).not.toBeNull();
    expect(screen.getByTestId("stub-ifc-viewer")).toBeTruthy();
    expect(await screen.findByTestId("stub-mapping-view")).toBeTruthy();
    const style = (wrapper as HTMLElement).style;
    expect(style.position).toBe("absolute");
  });

  it("the wizard overlay takes precedence over the PDF overlay (wizard renders, PDF does not)", () => {
    // When the wizard is open, the PDF active version id is
    // ignored — MappingView resolves the latest version from
    // the calibration flow itself. The PDF overlay wrapper
    // should NOT be in the DOM in this case.
    useViewerStore.getState().setActivePdfVersionId("v-1");
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    renderPanel("b-1");
    expect(screen.queryByTestId("viewer-panel-pdf-overlay")).toBeNull();
    expect(screen.getByTestId("viewer-panel-wizard-overlay")).toBeTruthy();
  });

  it("the wizard overlay is pointer-events: none (Task 15 follow-up regression)", () => {
    // Regression: the absolute wrapper was originally
    // `pointer-events: auto`, which captured every mouse
    // event. The IfcViewer's MouseNavigation never got drag
    // / scroll events through the wizard's 3D pane, so the
    // 3D camera didn't respond. Fix: `pointer-events: none`
    // on the wrapper; MappingView's children (status bar,
    // PDF pane, 3D pane during PICK_WORLD_* steps) opt back
    // in to `auto` on their own.
    useViewerStore.getState().startCalibration("pdf-1", "Level 1");
    renderPanel("b-1");
    const wrapper = screen.getByTestId("viewer-panel-wizard-overlay") as HTMLElement;
    expect(wrapper.style.pointerEvents).toBe("none");
  });

  it("the PDF overlay is pointer-events: none (same regression)", () => {
    // The PDF branch was also using `pointer-events: auto` on
    // the wrapper. Same fix.
    useViewerStore.getState().setActivePdfVersionId("v-1");
    renderPanel("b-1");
    const wrapper = screen.getByTestId("viewer-panel-pdf-overlay") as HTMLElement;
    expect(wrapper.style.pointerEvents).toBe("none");
  });
});
