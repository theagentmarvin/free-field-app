// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

// TasksPanelBody's only @ff/tasks-react runtime needs are the task
// source, the pure panel/scope logic, `restorePinView`, and the style
// `tokens`. Everything else is structural. We stub the module so the
// row-click seam (restorePinView AND onOpenTask) is under test with no
// Firebase/Dexie.
const mocks = vi.hoisted(() => ({
  usePanelTasks: vi.fn(),
  restorePinView: vi.fn(),
}));

vi.mock("@ff/tasks-react", () => ({
  tokens: {
    color: {
      text: "#1b1f24",
      text2: "#5b626b",
      muted: "#8a919c",
      primary: "#181c22",
      onPrimary: "#ffffff",
      surface: "#ffffff",
      surface2: "#fafbfc",
      border: "#e7e9ec",
      borderStrong: "#d6dbe1",
      danger: "#d64545",
      focusRing: "#2a5bb8",
    },
    radius: { pill: 999 },
    fontSize: { sm: 12, md: 13, lg: 16 },
  },
  PANEL_CHIPS: ["all"],
  usePanelTasks: mocks.usePanelTasks,
  usePanelActorUid: () => "admin",
  restorePinView: mocks.restorePinView,
  scopeTasks: (tasks: unknown[]) => tasks,
  filterTasks: (tasks: unknown[]) => tasks,
  panelBadgeState: (tasks: unknown[]) => ({ count: (tasks as unknown[]).length }),
  isPanelOverdue: () => false,
  statusAccent: () => ({ bg: "#181c22" }),
  formatTaskNum: (n: number) => `T${String(n).padStart(3, "0")}`,
}));

import TasksPanelBody from "../src/TasksPanelBody";

function task(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    num: 1,
    title: "Set door frame",
    status: 20,
    location: null,
    ...over,
  };
}

describe("TasksPanelBody", () => {
  it("row click calls restorePinView AND onOpenTask with the task id", () => {
    mocks.usePanelTasks.mockReturnValue([
      task({
        location: {
          bim: {
            worldPoint: [1, 2, 3],
            elements: [{ modelId: "m1", expressId: 7 }],
            cameraPose: null,
          },
        },
      }),
    ]);

    const onOpenTask = vi.fn();
    const viewerRef = createRef<IfcViewerHandle>();
    (viewerRef as { current: unknown }).current = {}; // mounted handle

    render(
      <TasksPanelBody
        viewerRef={viewerRef}
        storeyName={null}
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByTestId("tasks-panel-row-t1"));

    expect(mocks.restorePinView).toHaveBeenCalledTimes(1);
    expect(mocks.restorePinView).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: "t1" }),
    );
    expect(onOpenTask).toHaveBeenCalledWith("t1");
  });

  it("calls onOpenTask even when the viewer handle is not mounted", () => {
    mocks.restorePinView.mockClear();
    mocks.usePanelTasks.mockReturnValue([task({ id: "t2", num: 2 })]);

    const onOpenTask = vi.fn();
    const viewerRef = createRef<IfcViewerHandle>(); // current === null

    render(
      <TasksPanelBody
        viewerRef={viewerRef}
        storeyName={null}
        onOpenTask={onOpenTask}
      />,
    );

    fireEvent.click(screen.getByTestId("tasks-panel-row-t2"));

    expect(mocks.restorePinView).not.toHaveBeenCalled();
    expect(onOpenTask).toHaveBeenCalledWith("t2");
  });
});