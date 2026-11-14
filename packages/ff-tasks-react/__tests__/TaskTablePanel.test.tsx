// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { TaskView } from "@ff/tasks";

import { TaskTablePanel } from "../src/TaskTablePanel";
import { COLUMN_STORAGE_KEY, type TaskTableRow } from "../src/tableColumns";
import { clearPhotoUrlCache } from "../src/usePhotoUrl";

/**
 * Wave 5A · TaskTablePanel seams. Renders only the visible columns,
 * cycles header sort asc→desc→none, shows pending/failed row badges,
 * fires onOpen on row click, and drives the column picker (search,
 * OK persists, Cancel discards, num pinned).
 */

function row(over: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 100,
    assigneeName: "Ana",
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

function openPicker(): void {
  fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
}

beforeEach(() => {
  localStorage.clear();
  clearPhotoUrlCache();
});

afterEach(() => {
  cleanup();
});

describe("TaskTablePanel — assignee cell", () => {
  it("keeps avatar and name on one line (inline-flex, not stacked)", () => {
    const { container } = render(<TaskTablePanel rows={[row({ assigneeName: "Ana Silva" })]} now={0} />);
    const cell = container.querySelector(".ff-task-assignee-cell") as HTMLElement;
    expect(cell.style.display).toBe("inline-flex");
    expect(cell.textContent).toContain("Ana Silva");
  });
});

describe("TaskTablePanel — columns", () => {
  it("renders only the approved default visible columns", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    for (const id of ["num", "title", "type", "status", "assigneeName", "deadline"]) {
      expect(screen.getByTestId(`th-${id}`)).toBeTruthy();
    }
    for (const id of ["photos", "entryCount", "updatedAt", "createdAt", "createdBy", "location"]) {
      expect(screen.queryByTestId(`th-${id}`)).toBeNull();
    }
  });

  it("header click cycles sort asc → desc → none", () => {
    const rows = [row({ id: "a", status: 40 }), row({ id: "b", status: 10 }), row({ id: "c", status: 20 })];
    render(<TaskTablePanel rows={rows} now={0} />);
    const th = screen.getByTestId("th-status");
    expect(th.getAttribute("aria-sort")).toBe("none");

    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("none");
  });

  it("header sort actually reorders rows (status asc)", () => {
    const { container } = render(
      <TaskTablePanel
        rows={[
          row({ id: "a", status: 40 }),
          row({ id: "b", status: 10 }),
          row({ id: "c", status: 20 }),
        ]}
        now={0}
      />
    );
    fireEvent.click(screen.getByTestId("th-status"));
    const labels = [...container.querySelectorAll<HTMLElement>(".ff-task-table-status")].map((el) =>
      el.textContent?.trim()
    );
    expect(labels).toEqual(["Inbox", "Ongoing", "Awaiting approval"]);
  });
});

describe("TaskTablePanel — row semantics", () => {
  it("pending rows show the ⋯ marker, failed rows the retry button", () => {
    render(
      <TaskTablePanel
        rows={[
          row({ id: "p", pending: true, failed: false }),
          row({ id: "f", pending: true, failed: true }),
        ]}
        now={0}
        onRetry={vi.fn()}
      />
    );
    expect(screen.getByText("⋯")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry failed action" })).toBeTruthy();
  });

  it("row click fires onOpen with the task", () => {
    const onOpen = vi.fn();
    const t = row({ id: "a", title: "Crack in slab" });
    render(<TaskTablePanel rows={[t]} now={0} onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Crack in slab"));
    expect(onOpen).toHaveBeenCalledWith(t as TaskView);
  });

  it("retry click stops propagation (does not open the row)", () => {
    const onOpen = vi.fn();
    const onRetry = vi.fn();
    const t = row({ id: "f", pending: true, failed: true });
    render(<TaskTablePanel rows={[t]} now={0} onOpen={onOpen} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry failed action" }));
    expect(onRetry).toHaveBeenCalledWith(t as TaskView);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders a photo thumb in the title cell when a resolver resolves", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    render(
      <TaskTablePanel
        rows={[row({ photos: [{ storagePath: "p/a.jpg" }] })]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );
    const thumb = await screen.findByTestId("ff-task-table-thumb");
    expect(thumb.getAttribute("src")).toBe("https://files.test/p/a.jpg");
  });

  it("renders the location snapshot thumb in the location column (Day-3)", async () => {
    localStorage.setItem("ff-task-columns", JSON.stringify(["num", "location"]));
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    render(
      <TaskTablePanel
        rows={[
          row({
            location: { bim: { elements: [{ modelId: "m1", expressId: 7 }] }, pdf: null },
            locationThumbPath: "projects/p1/tasks/t1/location-thumb.jpg",
          }),
        ]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );
    const thumb = await screen.findByTestId("ff-location-thumb");
    expect(thumb.getAttribute("src")).toBe("https://files.test/projects/p1/tasks/t1/location-thumb.jpg");
  });
});

describe("TaskTablePanel — column picker", () => {
  it("opens on the Columns button and pins the num checkbox", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    expect(screen.queryByTestId("ff-task-columns-picker")).toBeNull();
    openPicker();
    expect(screen.getByTestId("ff-task-columns-picker")).toBeTruthy();

    const numBox = screen.getByTestId("columns-checkbox-num") as HTMLInputElement;
    expect(numBox.checked).toBe(true);
    expect(numBox.disabled).toBe(true);
  });

  it("search filters the checkbox list by label", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    openPicker();
    fireEvent.change(screen.getByLabelText("Search columns"), { target: { value: "dead" } });
    expect(screen.getByTestId("columns-checkbox-deadline")).toBeTruthy();
    expect(screen.queryByTestId("columns-checkbox-assigneeName")).toBeNull();
    expect(screen.queryByTestId("columns-checkbox-status")).toBeNull();
  });

  it("OK commits the new visible set and keeps the picker closed", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    openPicker();
    fireEvent.click(screen.getByTestId("columns-checkbox-photos"));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(screen.queryByTestId("ff-task-columns-picker")).toBeNull();
    expect(screen.getByTestId("th-photos")).toBeTruthy();
    const saved = JSON.parse(localStorage.getItem(COLUMN_STORAGE_KEY) ?? "[]") as string[];
    expect(saved).toContain("photos");
  });

  it("Cancel discards the draft — no column change, nothing persisted", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    openPicker();
    fireEvent.click(screen.getByTestId("columns-checkbox-photos"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("ff-task-columns-picker")).toBeNull();
    expect(screen.queryByTestId("th-photos")).toBeNull();
    expect(localStorage.getItem(COLUMN_STORAGE_KEY)).toBeNull();
  });
});

describe("TaskTablePanel — column filters (Wave 10)", () => {
  it("funnel opens a popover and does not change sort", () => {
    render(
      <TaskTablePanel rows={[row({ status: 20 }), row({ id: "b", status: 40 })]} now={0} />
    );
    const th = screen.getByTestId("th-status");
    expect(th.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    expect(screen.getByTestId("ff-task-filter-popover")).toBeTruthy();
    expect(th.getAttribute("aria-sort")).toBe("none"); // funnel click must not sort
  });

  it("picking a distinct value filters rows and shows an active count", () => {
    render(
      <TaskTablePanel
        rows={[
          row({ id: "a", title: "Alpha", status: 20 }),
          row({ id: "b", title: "Beta", status: 40 }),
        ]}
        now={0}
      />
    );
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Beta")).toBeTruthy();

    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ongoing" }));

    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText("Beta")).toBeNull();
    expect(screen.getByTestId("filter-funnel-status").textContent).toContain("1");
  });

  it("Clear filters resets every column", () => {
    render(
      <TaskTablePanel
        rows={[
          row({ id: "a", title: "Alpha", status: 20 }),
          row({ id: "b", title: "Beta", status: 40 }),
        ]}
        now={0}
      />
    );
    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ongoing" }));
    expect(screen.queryByText("Beta")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clear filters/i })).toBeNull();
  });

  it("Escape closes the popover", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    expect(screen.getByTestId("ff-task-filter-popover")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("ff-task-filter-popover")).toBeNull();
  });

  it("outside mousedown closes the popover", () => {
    render(<TaskTablePanel rows={[row()]} now={0} />);
    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    expect(screen.getByTestId("ff-task-filter-popover")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("ff-task-filter-popover")).toBeNull();
  });

  it("header click still sorts with a funnel present", () => {
    const rows = [
      row({ id: "a", status: 40 }),
      row({ id: "b", status: 10 }),
      row({ id: "c", status: 20 }),
    ];
    render(<TaskTablePanel rows={rows} now={0} />);
    const th = screen.getByTestId("th-status");
    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("ascending");
    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("descending");
    fireEvent.click(th);
    expect(th.getAttribute("aria-sort")).toBe("none");
  });
});