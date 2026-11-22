// @vitest-environment jsdom
//
// The persistent viewer surface must mount ONCE for the whole session: moving
// between route hosts (Models slot, Linkview pane, Documents slot, or no host
// at all while a route is loading) only MOVES its DOM, it never remounts the
// <IfcViewer> subtree. A React portal re-keyed by its container remounts its
// children, which used to reload and re-tessellate the whole model on every
// Models <-> Documents / LinkView round trip.
import { createRef } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const counts = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../src/ViewerSurface", async () => {
  const React = await import("react");
  return {
    default: () => {
      React.useEffect(() => {
        counts.mounts += 1;
        return () => {
          counts.unmounts += 1;
        };
      }, []);
      return React.createElement("div", { "data-testid": "surface-probe" });
    },
  };
});
vi.mock("@ff/auth", () => ({ useProjectId: () => "p1" }));
vi.mock("@ff/data/hooks", () => ({ useIfcFiles: () => [] }));
vi.mock("@ff/data/db/database", () => ({ db: {} }));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => undefined }));
vi.mock("@ff/viewer-tools", () => ({
  ViewerToolsProvider: ({ children }: { children: unknown }) => children,
  useModelsToolFilter: () => undefined,
  useViewerSelectionSync: () => undefined,
  useViewerExpressIdMaps: () => ({ modelToExpressIds: new Map() }),
  useModelsToolStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ activeBuildingId: null, setActiveBuildingId: () => undefined, activeStoreyName: null, setActiveStoreyName: () => undefined }),
}));
vi.mock("../src/modelsDataSource", () => ({ modelsDataSource: {} }));
vi.mock("../src/taskDetailStore", () => ({
  useTaskDetailStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ detailTaskId: null, openTask: () => undefined, closeTask: () => undefined }),
}));

import PersistentViewerSurface from "../src/PersistentViewerSurface";

describe("PersistentViewerSurface", () => {
  it("mounts once across host changes and moves its DOM into the active host", () => {
    counts.mounts = 0;
    counts.unmounts = 0;
    const hostA = document.createElement("div");
    const hostB = document.createElement("div");
    const hostC = document.createElement("div");
    for (const h of [hostA, hostB, hostC]) document.body.appendChild(h);
    const viewerRef = createRef() as never;
    const props = { viewerRef, showViewerToolbar: false };

    const { rerender } = render(<PersistentViewerSurface {...props} hostNode={hostA} />);
    const probe = hostA.querySelector('[data-testid="surface-probe"]');
    expect(probe).not.toBeNull();
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });

    rerender(<PersistentViewerSurface {...props} hostNode={hostB} />); // Models -> Documents
    expect(hostA.querySelector('[data-testid="surface-probe"]')).toBeNull();
    expect(hostB.querySelector('[data-testid="surface-probe"]')).toBe(probe); // the SAME element, moved
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });

    rerender(<PersistentViewerSurface {...props} hostNode={null} />); // between routes: no host
    expect(probe!.isConnected).toBe(true); // parked off-screen, not unmounted
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });

    rerender(<PersistentViewerSurface {...props} hostNode={hostC} />); // back to Models
    expect(hostC.querySelector('[data-testid="surface-probe"]')).toBe(probe);
    expect(counts).toEqual({ mounts: 1, unmounts: 0 });
  });
});
