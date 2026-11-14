// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TaskMiniPanel } from "../src/TaskMiniPanel";
import type { PanelTask } from "../src/panelLogic";

/**
 * Wave 9 · <TaskMiniPanel> (spec §A). Collapsed pill → bottom sheet on
 * phone, desktop right rail via `useIsWide` (matchMedia stubbed).
 * Rows render formatTaskNum + ![truncated] title + assignee initial;
 * filter chips switch rows; onLocate fires with the tapped task;
 * selected-row accent; the overdue dot; and a11y labels.
 */

function task(over: Partial<PanelTask> = {}): PanelTask {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 100,
    assigneeName: "Ana Silva",
    assigneeUid: "ana",
    lastAction: "create",
    entryCount: 1,
    location: { storeyName: "L12" },
    ...over,
  };
}

/** Stub matchMedia — `useIsWide` defaults true when absent, so the
 *  phone tests MUST install a narrow media query. */
function setViewport(wide: boolean): void {
  const mql = {
    matches: wide,
    media: "(min-width: 768px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation(() => mql),
  });
}

beforeEach(() => {
  setViewport(false);
});

afterEach(() => {
  // @ts-expect-error reset to the jsdom default (absence)
  delete window.matchMedia;
});

describe("TaskMiniPanel — phone", () => {
  it("starts collapsed: pill visible, no sheet", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ location: { storeyName: "L12" } })]}
        storeyName="L12"
        onLocate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("task-mini-panel-pill")).toBeInTheDocument();
    expect(screen.queryByTestId("task-mini-panel-sheet")).toBeNull();
  });

  it("pill aria-label reports the in-scope count", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ id: "a", location: { storeyName: "L12" } }), task({ id: "b", location: { storeyName: "L12" } })]}
        storeyName="L12"
        onLocate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("task-mini-panel-pill")).toHaveAttribute("aria-label", "Tasks in view: 2");
  });

  it("shows a red overdue dot when any in-scope task is overdue", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ id: "late", status: 20, deadline: 1, location: { storeyName: "L12" } })]}
        storeyName="L12"
        now={100}
        onLocate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("task-mini-panel-overdue-dot")).toBeInTheDocument();
  });

  it("no overdue dot when nothing late", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ id: "ok", status: 10, location: { storeyName: "L12" } })]}
        storeyName="L12"
        onLocate={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("task-mini-panel-overdue-dot")).toBeNull();
  });

  it("tapping the pill expands the sheet; tapping the scrim collapses it", () => {
    render(
      <TaskMiniPanel tasks={[task({ location: { storeyName: "L12" } })]} storeyName="L12" onLocate={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    const sheet = screen.getByTestId("task-mini-panel-sheet");
    expect(sheet).toBeInTheDocument();
    expect(sheet).toHaveAttribute("role", "dialog");

    fireEvent.click(screen.getByTestId("task-mini-panel-scrim"));
    expect(screen.queryByTestId("task-mini-panel-sheet")).toBeNull();
    expect(screen.getByTestId("task-mini-panel-pill")).toBeInTheDocument();
  });

  it("Escape collapses the open sheet", () => {
    render(
      <TaskMiniPanel tasks={[task({ location: { storeyName: "L12" } })]} storeyName="L12" onLocate={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    expect(screen.getByTestId("task-mini-panel-sheet")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("task-mini-panel-sheet")).toBeNull();
  });

  it("rows render formatTaskNum + title + assignee initial, as buttons with full-title aria-label", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ num: 1, title: "Patch drywall", assigneeName: "Mateo Rojas" })]}
        storeyName="L12"
        onLocate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    expect(screen.getByText("T001")).toBeInTheDocument();
    expect(screen.getByText("Patch drywall")).toBeInTheDocument();
    expect(screen.getByText("M")).toBeInTheDocument(); // assignee initial
    expect(screen.getByRole("button", { name: "T001 Patch drywall" })).toBeInTheDocument();
  });

  it("truncates long titles to one line", () => {
    render(
      <TaskMiniPanel
        tasks={[task({ title: "A very long task title that should be truncated to a single line" })]}
        storeyName="L12"
        onLocate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    const title = screen.getByText("A very long task title that should be truncated to a single line");
    expect((title as HTMLElement).style.whiteSpace).toBe("nowrap");
    expect((title as HTMLElement).style.textOverflow).toBe("ellipsis");
  });

  it("filter chips switch the rows; the count badge follows", () => {
    const rows = [
      task({ id: "a", num: 1, status: 10, assigneeUid: "me", title: "Open one" }),
      task({ id: "b", num: 2, status: 65, assigneeUid: "me", title: "Done one" }),
      task({ id: "c", num: 3, status: 40, assigneeUid: "other", title: "Their one" }),
    ];
    render(<TaskMiniPanel tasks={rows} storeyName="L12" actorUid="me" onLocate={vi.fn()} />);
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));

    expect(screen.getByText("Open one")).toBeInTheDocument();
    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.getByText("Their one")).toBeInTheDocument();

    // Open filter → drops the terminal "Done one"
    fireEvent.click(screen.getByRole("radio", { name: "Open" }));
    expect(screen.getByText("Open one")).toBeInTheDocument();
    expect(screen.queryByText("Done one")).toBeNull();
    expect(screen.getByText("Their one")).toBeInTheDocument();

    // Mine filter → only my rows ("me")
    fireEvent.click(screen.getByRole("radio", { name: "Mine" }));
    expect(screen.getByText("Open one")).toBeInTheDocument();
    expect(screen.getByText("Done one")).toBeInTheDocument();
    expect(screen.queryByText("Their one")).toBeNull();
  });

  it("onLocate fires with the tapped task and marks the row selected (accent)", () => {
    const onLocate = vi.fn();
    const rows = [task({ id: "a", num: 1, title: "First" }), task({ id: "b", num: 2, title: "Second" })];
    render(<TaskMiniPanel tasks={rows} storeyName="L12" onLocate={onLocate} />);
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));

    fireEvent.click(screen.getByRole("button", { name: "T002 Second" }));
    expect(onLocate).toHaveBeenCalledTimes(1);
    expect(onLocate.mock.calls[0][0]).toMatchObject({ id: "b", num: 2, title: "Second" });

    const selected = screen.getByRole("button", { name: "T002 Second" });
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected.className).toContain("ff-task-mini-row--selected");
  });

  it("re-tapping a selected row re-locates (does not collapse)", () => {
    const onLocate = vi.fn();
    render(<TaskMiniPanel tasks={[task({ id: "a", num: 1, title: "First" })]} storeyName="L12" onLocate={onLocate} />);
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    const row = screen.getByRole("button", { name: "T001 First" });
    fireEvent.click(row);
    fireEvent.click(row);
    expect(onLocate).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("task-mini-panel-sheet")).toBeInTheDocument(); // still open
  });
});

describe("TaskMiniPanel — desktop right dock", () => {
  it("starts minimized: right-edge tab, no drawer, no pill and no scrim", () => {
    setViewport(true);
    render(
      <TaskMiniPanel tasks={[task({ location: { storeyName: "L12" } })]} storeyName="L12" onLocate={vi.fn()} />,
    );
    expect(screen.getByTestId("task-mini-panel-rail-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("task-mini-panel-rail")).toBeNull();
    expect(screen.queryByTestId("task-mini-panel-pill")).toBeNull();
    expect(screen.queryByTestId("task-mini-panel-scrim")).toBeNull();
  });

  it("tab carries the count badge + overdue dot", () => {
    setViewport(true);
    render(
      <TaskMiniPanel
        tasks={[task({ id: "late", status: 20, deadline: 1, location: { storeyName: "L12" } })]}
        storeyName="L12"
        now={100}
        onLocate={vi.fn()}
      />,
    );
    expect(screen.getByTestId("task-mini-panel-rail-tab")).toHaveAttribute(
      "aria-label",
      "Tasks in view: 1",
    );
    expect(screen.getByTestId("task-mini-panel-overdue-dot")).toBeInTheDocument();
  });

  it("tapping the tab opens the drawer; the ✕ collapses back to the tab", () => {
    setViewport(true);
    render(
      <TaskMiniPanel tasks={[task({ num: 1, title: "Crack in slab" })]} storeyName="L12" onLocate={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-rail-tab"));

    const drawer = screen.getByTestId("task-mini-panel-rail");
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveAttribute("role", "dialog");
    expect(screen.queryByTestId("task-mini-panel-rail-tab")).toBeNull();

    // Rows + filter chips render inside the drawer.
    expect(screen.getByText("T001")).toBeInTheDocument();
    expect(screen.getByText("Crack in slab")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Open" })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("task-mini-panel-collapse"));
    expect(screen.queryByTestId("task-mini-panel-rail")).toBeNull();
    expect(screen.getByTestId("task-mini-panel-rail-tab")).toBeInTheDocument();
  });
});
describe("TaskMiniPanel — wave 54 V6 deadline text", () => {
  const NOW = new Date(2026, 10, 8, 12).getTime();
  const DAY = 86_400_000;

  it("rows show relative deadline text; the old Overdue pill is gone", () => {
    render(
      <TaskMiniPanel
        tasks={[
          task({ id: "today", num: 1, deadline: NOW, location: { storeyName: "L12" } }),
          task({ id: "late", num: 2, deadline: NOW - 2 * DAY, location: { storeyName: "L12" } }),
        ]}
        storeyName="L12"
        now={NOW}
        onLocate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    expect(screen.getByTestId("task-mini-deadline-today")).toHaveTextContent("Today");
    expect(screen.getByTestId("task-mini-deadline-late")).toHaveTextContent("2d late");
    // The only "Overdue" text left is the filter CHIP — the row pill is
    // gone (the V6 deadline text replaces it).
    expect(screen.getAllByText("Overdue")).toHaveLength(1);
  });

  it("far dates fall back to dd MMM yyyy; no deadline renders nothing", () => {
    render(
      <TaskMiniPanel
        tasks={[
          task({
            id: "far",
            num: 3,
            deadline: new Date(2027, 5, 1).getTime(),
            location: { storeyName: "L12" },
          }),
          task({ id: "none", num: 4, location: { storeyName: "L12" } }),
        ]}
        storeyName="L12"
        now={NOW}
        onLocate={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("task-mini-panel-pill"));
    expect(screen.getByTestId("task-mini-deadline-far")).toHaveTextContent("01 Jun 2027");
    expect(screen.queryByTestId("task-mini-deadline-none")).toBeNull();
  });
});
