// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createRef, forwardRef } from "react";
import { render, screen } from "@testing-library/react";

/**
 * Wave 9 seam test — the Models host mounts the 3D marker
 * (TaskCalloutLayer3D) alongside the viewer and forwards the ACTIVE
 * STOREY name into the viewer slice. Wave 40: the floating
 * <TaskMiniPanel> no longer mounts — the task count is a badge on the
 * toolbar's Tasks button. The viewer/data/tasks internals are stubbed
 * so the seam is what's under test.
 */

vi.mock("@ff/viewer-react", async () => {
  const React = await import("react");
  const MockIfcViewer = forwardRef<unknown, Record<string, unknown>>(
    (_props, _ref) => React.createElement("div", { "data-testid": "seam-ifc" }),
  );
  MockIfcViewer.displayName = "IfcViewer";
  return {
    IfcViewer: MockIfcViewer,
  };
});

// Wave 12: the bottom toolbar pulls `tokens` from @ff/tasks-react and
// `useIsMobile` from @ff/viewer-tools (both fully mocked here). Mocking
// the local toolbars keeps the seam test focused on the panel + marker.
vi.mock("../src/ViewerToolbar", () => ({
  default: () => null,
}));

// Wave 47: the right-click context toolbar is another floating overlay
// with its own viewer/data/tasks imports — stub it out of the seam.
vi.mock("../src/SelectionContextToolbar", () => ({
  default: () => null,
}));

vi.mock("@ff/data/db/tables/fragBlobs", () => ({ getFragBlob: vi.fn() }));

vi.mock("@ff/data/hooks", () => ({
  useIfcFiles: () => [],
  useIfcPipeline: () => ({ registerFragments: vi.fn(), loadIfc: vi.fn(), isLoading: false }),
  getStoreysForBuilding: vi.fn(),
}));

vi.mock("@ff/viewer-tools", () => ({
  useModelsToolStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ activeStoreyName: "L12", setActiveStoreyName: vi.fn() }),
  // Wave 50: Viewer now imports the manual-visibility overlay for the
  // task detail "Hide instance" action.
  useManualVisibilityStore: () => ({ hideIds: vi.fn(), showAll: vi.fn() }),
}));

vi.mock("@ff/tasks-react", async () => {
  const React = await import("react");
  const Nullish = () => null;
  return {
    TapCreateTask3D: Nullish,
    TaskCalloutLayer3D: () => React.createElement("div", { "data-testid": "seam-marker-3d" }),
    TaskDetailHost: Nullish,
    usePanelTasks: () => [],
    usePanelActorUid: () => "admin",
    useTaskPhotoResolver: () => undefined,
    restorePinView: vi.fn(),
  };
});

vi.mock("@ff/auth", () => ({ useProjectId: () => "p1" }));

import Viewer from "../src/Viewer";
import type { IfcViewerHandle } from "@ff/viewer-react";

describe("Viewer — panel seam (3D)", () => {
  it("mounts the marker layer; the floating mini panel is gone (wave 40)", () => {
    const ref = createRef<IfcViewerHandle>();
    render(<Viewer buildingId="b1" viewerRef={ref} />);

    expect(screen.getByTestId("seam-ifc")).toBeInTheDocument();
    expect(screen.getByTestId("seam-marker-3d")).toBeInTheDocument();
    // Wave 40: the floating "N tasks" pill no longer mounts — the
    // task count is a badge on the toolbar's Tasks button instead.
    expect(screen.queryByTestId("seam-panel")).toBeNull();
  });
});