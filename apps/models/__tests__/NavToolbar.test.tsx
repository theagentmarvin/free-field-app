// @vitest-environment jsdom
//
// apps/models/__tests__/NavToolbar.test.tsx
//
// Wave 35 (toolbar-nav redesign) — the floating icon-only toolbar.
//
// Contract under test:
//   - EXACTLY three buttons, icon-only, native `title` tooltips.
//   - Toggle: inactive → open, active → close, other → swap.
//   - No nav button is highlighted while Properties owns the slot
//     (Properties is selection-driven, not button-driven).

import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { useModelsToolStore } from "@ff/viewer-tools";

import NavToolbar from "../src/NavToolbar";

// The @ff/viewer-tools barrel re-exports hooks that import
// @ff/viewer-react at RUNTIME, and that package pulls in three.js'
// webgpu build — fatal in jsdom. Stub the whole module: the panel
// surfaces under test only need the data-source seam.
vi.mock("@ff/viewer-react", () => ({
  IfcViewer: () => null,
  buildInvertedIndex: () => new Map(),
  evaluateRule: () => true,
}));

// Wave 40 — NavToolbar reads the open-task count for the Tasks badge.
// The real hook runs a Dexie live query; stub it with a hoisted array
// the tests can re-arm per case (tokens etc. stay real).
const h = vi.hoisted(() => ({ panelTasks: [] as unknown[] }));
vi.mock("@ff/tasks-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/tasks-react")>();
  return { ...actual, usePanelTasks: () => h.panelTasks };
});


beforeEach(() => {
  useModelsToolStore.setState({ activeNavPanel: null });
  h.panelTasks = [];
});

describe("NavToolbar", () => {
  it("renders exactly three icon-only buttons with tooltips", () => {
    render(<NavToolbar />);

    const bar = screen.getByTestId("nav-toolbar");
    const buttons = bar.querySelectorAll("button");
    expect(buttons).toHaveLength(3);

    expect(screen.getByTitle("Models & Levels")).toBeInTheDocument();
    expect(screen.getByTitle("Filters")).toBeInTheDocument();
    expect(screen.getByTitle("Tasks")).toBeInTheDocument();

    // Icon-only: no text labels inside the pill.
    expect(bar.textContent?.trim()).toBe("");
  });

  it("opens an inactive panel, closes the active one and swaps in place", () => {
    render(<NavToolbar />);

    fireEvent.click(screen.getByTestId("nav-toolbar-models"));
    expect(useModelsToolStore.getState().activeNavPanel).toBe("models");

    // Active button → close.
    fireEvent.click(screen.getByTestId("nav-toolbar-models"));
    expect(useModelsToolStore.getState().activeNavPanel).toBe(null);

    // Another button → swap.
    fireEvent.click(screen.getByTestId("nav-toolbar-filters"));
    expect(useModelsToolStore.getState().activeNavPanel).toBe("filters");

    fireEvent.click(screen.getByTestId("nav-toolbar-tasks"));
    expect(useModelsToolStore.getState().activeNavPanel).toBe("tasks");
  });

  it("highlights no button while Properties owns the slot", () => {
    useModelsToolStore.setState({ activeNavPanel: "props" });
    render(<NavToolbar />);

    expect(screen.getByTestId("nav-toolbar-models")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("nav-toolbar-filters")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("nav-toolbar-tasks")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("marks the active button as pressed", () => {
    useModelsToolStore.setState({ activeNavPanel: "filters" });
    render(<NavToolbar />);

    expect(screen.getByTestId("nav-toolbar-filters")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

describe("NavToolbar task badge (wave 40)", () => {
  it("shows the open-task count on the Tasks button", () => {
    h.panelTasks = [{}, {}, {}];
    render(<NavToolbar />);

    expect(screen.getByTestId("nav-toolbar-tasks-badge")).toHaveTextContent(
      "3",
    );
    // Still exactly three buttons — the badge is a span, not a button.
    expect(
      screen.getByTestId("nav-toolbar").querySelectorAll("button"),
    ).toHaveLength(3);
  });

  it("hides the badge when there are no tasks", () => {
    h.panelTasks = [];
    render(<NavToolbar />);

    expect(screen.queryByTestId("nav-toolbar-tasks-badge")).toBeNull();
  });
});
