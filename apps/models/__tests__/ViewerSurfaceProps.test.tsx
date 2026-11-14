// @vitest-environment jsdom
// Wave 64 — prop forwarding through the persistent 3D surface:
//   - `renderPaused` (Documents PDF open) reaches <IfcViewer renderPaused>;
//   - the 3D task callout layer is scoped to the active building.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, forwardRef } from "react";
import { cleanup, render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  ifcProps: [] as Record<string, unknown>[],
  calloutProps: [] as Record<string, unknown>[],
  whereSpy: vi.fn(),
  setActive: vi.fn(),
}));

vi.mock("@ff/viewer-react", async () => {
  const React = await import("react");
  const MockIfcViewer = forwardRef<unknown, Record<string, unknown>>(
    (props, _ref) => {
      h.ifcProps.push(props);
      return React.createElement("div", { "data-testid": "ifc" });
    },
  );
  MockIfcViewer.displayName = "IfcViewer";
  return { IfcViewer: MockIfcViewer };
});

vi.mock("../src/ViewerToolbar", () => ({ default: () => null }));
vi.mock("../src/SelectionContextToolbar", () => ({ default: () => null }));
vi.mock("../src/modelsDataSource", () => ({ modelsDataSource: {} }));
vi.mock("@ff/data/db/tables/fragBlobs", () => ({ getFragBlob: vi.fn() }));
const auth = vi.hoisted(() => ({ pid: "p1" as string | undefined }));
vi.mock("@ff/auth", () => ({ useProjectId: () => auth.pid }));
vi.mock("@ff/data/db/database", () => ({
  db: {
    buildings: {
      where: (...a: unknown[]) => {
        h.whereSpy(...a);
        return { equals: (id: unknown) => { h.whereSpy("equals", id); return { toArray: async () => [] }; } };
      },
      toArray: vi.fn(async () => []),
    },
  },
}));
vi.mock("@ff/data/hooks", () => ({
  useIfcFiles: () => [],
  useIfcPipeline: () => ({ registerFragments: vi.fn() }),
  getStoreysForBuilding: vi.fn(),
}));

vi.mock("@ff/viewer-tools", async () => {
  const React = await import("react");
  const state = {
    activeBuildingId: "bldg-7",
    setActiveBuildingId: h.setActive,
    activeStoreyName: null,
    setActiveStoreyName: vi.fn(),
  };
  const store = (sel: (s: typeof state) => unknown) => sel(state);
  store.getState = () => state;
  return {
    ViewerToolsProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    useModelsToolStore: store,
    useModelsToolFilter: vi.fn(),
    useViewerExpressIdMaps: () => ({ modelToExpressIds: new Map() }),
    useViewerSelectionSync: vi.fn(),
    useManualVisibilityStore: () => ({ hideIds: vi.fn(), showAll: vi.fn() }),
  };
});

vi.mock("@ff/tasks-react", () => ({
  TapCreateTask3D: () => null,
  TaskCalloutLayer3D: (props: Record<string, unknown>) => {
    h.calloutProps.push(props);
    return null;
  },
  TaskDetailHost: () => null,
  useTaskPhotoResolver: () => undefined,
  restorePinView: vi.fn(),
}));

import PersistentViewerSurface from "../src/PersistentViewerSurface";
import type { IfcViewerHandle } from "@ff/viewer-react";

afterEach(() => {
  cleanup();
  h.ifcProps.length = 0;
  h.calloutProps.length = 0;
  h.whereSpy.mockClear();
  h.setActive.mockClear();
  auth.pid = "p1";
});

function mount(renderPaused?: boolean) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return render(
    <PersistentViewerSurface
      viewerRef={createRef<IfcViewerHandle>()}
      hostNode={host}
      showViewerToolbar={false}
      renderPaused={renderPaused}
    />,
  );
}

describe("PersistentViewerSurface prop forwarding (wave 64)", () => {
  it("forwards renderPaused=true to <IfcViewer>", () => {
    mount(true);
    expect(h.ifcProps.at(-1)?.renderPaused).toBe(true);
  });

  it("defaults renderPaused to false and resumes on toggle", () => {
    const r = mount();
    expect(h.ifcProps.at(-1)?.renderPaused).toBe(false);
    const host = document.createElement("div");
    r.rerender(
      <PersistentViewerSurface
        viewerRef={createRef<IfcViewerHandle>()}
        hostNode={host}
        showViewerToolbar={false}
        renderPaused
      />,
    );
    expect(h.ifcProps.at(-1)?.renderPaused).toBe(true);
  });

  it("scopes the 3D task callouts to the active building", () => {
    mount();
    expect(h.calloutProps.at(-1)?.buildingId).toBe("bldg-7");
  });
});

describe("PersistentViewerSurface project scoping (wave 66)", () => {
  it("forwards the current project id and scopes the building query", async () => {
    mount();
    expect(h.ifcProps.at(-1)?.projectId).toBe("p1");
    await vi.waitFor(() => expect(h.whereSpy).toHaveBeenCalledWith("equals", "p1"));
  });

  it("renders nothing and reads nothing while the project id is undefined", async () => {
    auth.pid = undefined;
    mount();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.ifcProps.length).toBe(0);
    expect(h.whereSpy).not.toHaveBeenCalled();
    expect(h.setActive).not.toHaveBeenCalled();
  });

  it("resets the active building when the project changes", () => {
    const host = document.createElement("div");
    const ref = createRef<IfcViewerHandle>();
    const el = () => (
      <PersistentViewerSurface viewerRef={ref} hostNode={host} showViewerToolbar={false} />
    );
    const r = render(el());
    expect(h.setActive).not.toHaveBeenCalledWith(null);
    auth.pid = "p2";
    r.rerender(el());
    expect(h.setActive).toHaveBeenCalledWith(null);
  });
});
