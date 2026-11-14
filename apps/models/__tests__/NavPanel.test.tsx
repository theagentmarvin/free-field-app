// @vitest-environment jsdom
//
// apps/models/__tests__/NavPanel.test.tsx
//
// Wave 35 (toolbar-nav redesign) — the ONE floating panel slot.
//
// Contract under test:
//   - One slot for every tenant (models / filters / tasks / props).
//   - Fixed geometry: 320px wide, min(500px, calc(100% - 120px)) tall,
//     top 66px / left 14px.
//   - The shell NEVER remounts on a tenant swap.
//   - Properties is conditional slot CONTENT: the drawer's
//     `setOnElementPick` subscription is installed ONCE and survives
//     every swap.
//   - Escape closes the slot.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import {
  useModelsToolStore,
  ViewerToolsProvider,
  type ViewerToolsDataSource,
} from "@ff/viewer-tools";
import type { IfcViewerHandle } from "@ff/viewer-react";

import NavPanel from "../src/NavPanel";

// The @ff/viewer-tools barrel re-exports hooks that import
// @ff/viewer-react at RUNTIME, and that package pulls in three.js'
// webgpu build — fatal in jsdom. Stub the whole module: the panel
// surfaces under test only need the data-source seam.
vi.mock("@ff/viewer-react", () => ({
  IfcViewer: () => null,
  buildInvertedIndex: () => new Map(),
  evaluateRule: () => true,
}));


// The task feed talks to Firebase; the panel body under test does not
// need it. Everything else from the package is real.
vi.mock("@ff/tasks-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@ff/tasks-react")>();
  return {
    ...actual,
    usePanelTasks: () => [],
    usePanelActorUid: () => null,
  };
});

const dataSource: ViewerToolsDataSource = {
  queryModels: async () => [],
  queryLevels: async () => [],
  queryPropertyCatalog: async () => [],
  queryFilterPresets: async () => [],
  saveFilterPreset: async (r) => r,
  removeFilterPreset: async () => undefined,
  queryFileName: async () => null,
  queryStoreys: async () => [],
};

function makeHandle(): IfcViewerHandle {
  return {
    setOnElementPick: vi.fn(),
    getElementData: async () => ({}),
    clearSelection: vi.fn(),
    selectElement: vi.fn(),
  } as unknown as IfcViewerHandle;
}

function renderPanel(handle: IfcViewerHandle) {
  const viewerRef = { current: handle } as React.RefObject<IfcViewerHandle>;
  return render(
    <ViewerToolsProvider dataSource={dataSource}>
      <NavPanel buildingId="b1" viewerRef={viewerRef} />
    </ViewerToolsProvider>,
  );
}

beforeEach(() => {
  useModelsToolStore.setState({
    activeNavPanel: null,
    selection: null,
  });
});

describe("NavPanel", () => {
  it("is closed by default and opens in the fixed slot geometry", () => {
    const handle = makeHandle();
    renderPanel(handle);

    const panel = screen.getByTestId("nav-panel");
    expect(panel).toHaveAttribute("data-open", "false");
    expect(panel.style.display).toBe("none");

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("models");
    });

    expect(panel).toHaveAttribute("data-open", "true");
    expect(panel.style.display).toBe("flex");
    expect(panel.style.width).toBe("320px");
    expect(panel.style.top).toBe("66px");
    expect(panel.style.left).toBe("14px");
    // jsdom's CSS parser rewrites `min(a, b)` into its own
    // serialization ("min(500px * , * calc(...))"), so compare the
    // normalized form.
    expect(panel.style.height.replace(/\s*\*\s*/g, "").replace(/\s/g, "")).toBe(
      "min(500px,calc(100%-120px))",
    );
  });

  it("shows the tenant title and swaps content in place", () => {
    const handle = makeHandle();
    renderPanel(handle);

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("models");
    });
    expect(screen.getByTestId("nav-panel-title")).toHaveTextContent(
      "Models & Levels",
    );

    // The SHELL must not remount on a tenant swap.
    const shell = screen.getByTestId("nav-panel");

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("filters");
    });
    expect(screen.getByTestId("nav-panel")).toBe(shell);
    expect(screen.getByTestId("nav-panel-title")).toHaveTextContent("Filters");

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("tasks");
    });
    expect(screen.getByTestId("nav-panel")).toBe(shell);
    expect(screen.getByTestId("nav-panel-title")).toHaveTextContent("Tasks");
  });

  it("opens Properties in the same slot when an element is selected", () => {
    const handle = makeHandle();
    renderPanel(handle);

    act(() => {
      useModelsToolStore.getState().selectElement({
        modelId: "m1",
        expressId: 42,
      });
    });

    expect(useModelsToolStore.getState().activeNavPanel).toBe("props");
    expect(screen.getByTestId("nav-panel-title")).toHaveTextContent(
      "Properties",
    );
    // Same slot — no second panel anywhere.
    expect(screen.getAllByTestId("nav-panel")).toHaveLength(1);
    expect(
      screen.getByTestId("nav-panel-properties").style.display,
    ).not.toBe("none");
  });

  it("keeps the pick subscription alive across tenant swaps", () => {
    const handle = makeHandle();
    const setOnElementPick = handle.setOnElementPick as unknown as ReturnType<
      typeof vi.fn
    >;
    renderPanel(handle);

    // Installed once on mount.
    expect(setOnElementPick).toHaveBeenCalledTimes(1);

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("models");
    });
    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("filters");
    });
    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("props");
    });

    // Never re-registered.
    expect(setOnElementPick).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and clears the selection", () => {
    const handle = makeHandle();
    renderPanel(handle);

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("models");
    });
    act(() => {
      useModelsToolStore
        .getState()
        .selectElement({ modelId: "m1", expressId: 7 });
    });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(useModelsToolStore.getState().activeNavPanel).toBe(null);
    expect(useModelsToolStore.getState().selection).toBe(null);
  });

  it("closes when the panel ✕ is pressed", () => {
    const handle = makeHandle();
    renderPanel(handle);

    act(() => {
      useModelsToolStore.getState().setActiveNavPanel("models");
    });
    fireEvent.click(screen.getByTestId("nav-panel-close"));

    expect(useModelsToolStore.getState().activeNavPanel).toBe(null);
  });
});

// Keeps the unused import honest (createRef is handy for future cases).
void createRef;
