// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TaskToolbar, type TaskToolbarProps } from "../src/TaskToolbar";

afterEach(cleanup);

function props(over: Partial<TaskToolbarProps> = {}): TaskToolbarProps {
  return {
    chip: "all",
    onChipChange: () => {},
    search: "",
    onSearchChange: () => {},
    sort: "updated",
    onSortChange: () => {},
    queued: 0,
    onOpenOutbox: () => {},
    canCreate: false,
    onCreate: () => {},
    exportCount: 3,
    ...over,
  } as TaskToolbarProps;
}

function open() {
  fireEvent.click(screen.getByLabelText("Export tasks"));
}

describe("TaskToolbar BCF export items", () => {
  it("shows both BCF items and calls onExportBcf with the version", () => {
    const onExportBcf = vi.fn();
    render(<TaskToolbar {...props({ onExportBcf })} />);
    open();
    expect(screen.getByTestId("export-bcf-21").textContent).toContain("BCF 2.1 (.bcfzip)");
    expect(screen.getByTestId("export-bcf-30").textContent).toContain("BCF 3.0 (.bcf)");
    fireEvent.click(screen.getByTestId("export-bcf-30"));
    expect(onExportBcf).toHaveBeenLastCalledWith("3.0");
    open();
    fireEvent.click(screen.getByTestId("export-bcf-21"));
    expect(onExportBcf).toHaveBeenLastCalledWith("2.1");
  });

  it("disables the items at 0 rows and while an export runs", () => {
    const onExportBcf = vi.fn();
    const { rerender } = render(<TaskToolbar {...props({ onExportBcf, exportCount: 0 })} />);
    open();
    expect((screen.getByTestId("export-bcf-21") as HTMLButtonElement).disabled).toBe(true);
    rerender(<TaskToolbar {...props({ onExportBcf, exportCount: 2, bcfExporting: true })} />);
    expect((screen.getByTestId("export-bcf-30") as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the real scope when a selection narrows it, and disables on an empty scope", () => {
    const onExportBcf = vi.fn();
    const { rerender } = render(<TaskToolbar {...props({ onExportBcf, exportCount: 8, bcfScope: { count: 3, fromSelection: true } })} />);
    open();
    expect(screen.getByTestId("export-bcf-scope").textContent).toContain("Selected · 3 tasks");
    expect((screen.getByTestId("export-bcf-21") as HTMLButtonElement).disabled).toBe(false);
    rerender(<TaskToolbar {...props({ onExportBcf, exportCount: 8, bcfScope: { count: 1, fromSelection: true } })} />);
    expect(screen.getByTestId("export-bcf-scope").textContent).toContain("Selected · 1 task");
    expect(screen.getByTestId("export-bcf-scope").textContent).not.toContain("tasks");
    rerender(<TaskToolbar {...props({ onExportBcf, exportCount: 8, bcfScope: { count: 8, fromSelection: false } })} />);
    expect(screen.queryByTestId("export-bcf-scope")).toBeNull();
    rerender(<TaskToolbar {...props({ onExportBcf, exportCount: 8, bcfScope: { count: 0, fromSelection: false } })} />);
    expect((screen.getByTestId("export-bcf-30") as HTMLButtonElement).disabled).toBe(true);
  });

  it("omits the items without onExportBcf", () => {
    render(<TaskToolbar {...props({ onExportCsv: () => {} })} />);
    open();
    expect(screen.queryByTestId("export-bcf-21")).toBeNull();
  });
});
