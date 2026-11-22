// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@ff/tasks-react", async (orig) => ({
  ...(await orig<typeof import("@ff/tasks-react")>()),
  usePanelActorUid: () => "u1",
}));

import TasksPanelBody from "../src/TasksPanelBody";

const task = (id: string, num: number, page: number, extra: Record<string, unknown> = {}) =>
  ({ id, num, title: `Task ${num}`, status: 1, location: { pdf: { page } }, ...extra }) as never;

describe("TasksPanelBody", () => {
  it("clicking a task jumps the sheet to its page and marks it selected", () => {
    const goToPage = vi.fn();
    render(
      <TasksPanelBody
        tasks={[task("a", 10, 3)]}
        currentPage={3}
        overlayRef={{ current: { goToPage } } as never}
      />,
    );
    const row = screen.getByTestId("documents-tasks-row-a");
    fireEvent.click(row);
    expect(goToPage).toHaveBeenCalledWith(3);
    expect(row).toHaveAttribute("aria-current", "true");
  });

  it("'All' reaches tasks on other pages and a jump goes to that page", () => {
    const goToPage = vi.fn();
    render(
      <TasksPanelBody
        tasks={[task("a", 10, 1), task("b", 12, 2)]}
        currentPage={1}
        overlayRef={{ current: { goToPage } } as never}
      />,
    );
    expect(screen.queryByTestId("documents-tasks-row-b")).toBeNull();
    expect(screen.getByTestId("documents-tasks-panel-count")).toHaveTextContent("1");
    fireEvent.click(screen.getAllByRole("radio", { name: "All" })[0]!);
    fireEvent.click(screen.getByTestId("documents-tasks-row-b"));
    expect(goToPage).toHaveBeenCalledWith(2);
  });

  it("shows an empty state and tolerates a missing overlay handle", () => {
    const { rerender } = render(<TasksPanelBody tasks={[]} currentPage={1} overlayRef={null} />);
    expect(screen.getByTestId("documents-tasks-panel-empty")).toHaveTextContent("No tasks on this page.");
    rerender(<TasksPanelBody tasks={[task("a", 1, 1)]} currentPage={1} overlayRef={null} />);
    expect(() => fireEvent.click(screen.getByTestId("documents-tasks-row-a"))).not.toThrow();
  });
});
