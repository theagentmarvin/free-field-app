// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTaskPrintHtml, type PrintTaskView } from "../src/printDocument";
import { TaskDetailView, type TaskDetailViewProps } from "../src/TaskDetailView";
import { TaskTablePanel } from "../src/TaskTablePanel";
import { clearPhotoUrlCache } from "../src/usePhotoUrl";

const pose = { pos: [1, 2, 3] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50, isOrtho: false };
const bim = { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: pose };
const pdf = { pdfFileId: "p1", page: 1, uv: [0.25, 0.5] as [number, number], calibId: "p1__L1" };
const t3d = "projects/p/tasks/t1/location-thumb.jpg";
const t2d = "projects/p/tasks/t1/location-thumb-2d.jpg";
const resolve = async (p: string) => `https://files.test/${p}`;

afterEach(() => {
  cleanup();
  clearPhotoUrlCache();
  localStorage.clear();
});

function detailProps(location: TaskDetailViewProps["location"]): TaskDetailViewProps {
  return {
    num: 12,
    title: "Crack",
    description: "",
    status: 20,
    assigneeName: null,
    deadline: null,
    location,
    entries: [],
    canAct: true,
    onComment: vi.fn(),
    onTransition: vi.fn(),
    onRetryEntry: vi.fn(),
    onClose: vi.fn(),
    resolvePhotoUrl: resolve,
    onShowIn3D: vi.fn(),
    onShowOnPlan: vi.fn(),
  };
}

describe("task detail location card", () => {
  it("LinkView task: both images side by side, 'Open in LinkView', one click target", async () => {
    const onShowIn3D = vi.fn();
    render(
      <TaskDetailView
        {...detailProps({ storeyName: "L1", origin: "linkview", thumb: { storagePath: t3d }, thumb2d: { storagePath: t2d }, bim, pdf })}
        onShowIn3D={onShowIn3D}
      />,
    );
    const two = await screen.findByTestId("detail-location-thumb-2d");
    const three = await screen.findByTestId("detail-location-thumb-3d");
    expect(two.getAttribute("src")).toContain("location-thumb-2d.jpg");
    expect(three.getAttribute("src")).toContain("location-thumb.jpg");
    expect(two.compareDocumentPosition(three) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("detail-location-open-label").textContent).toContain("Open in LinkView");
    expect(screen.getByTestId("detail-location-card").getAttribute("title")).toBe("Open in LinkView");
    // the single-image slot is not rendered
    expect(screen.queryByTestId("detail-location-thumb")).toBeNull();
  });

  it("Models task keeps the single image and 'Open in Models'", async () => {
    render(<TaskDetailView {...detailProps({ storeyName: "L1", thumb: { storagePath: t3d }, bim, pdf: null })} />);
    await screen.findByTestId("detail-location-thumb");
    expect(screen.queryByTestId("detail-location-thumb-2d")).toBeNull();
    expect(screen.getByTestId("detail-location-open-label").textContent).toContain("Open in Models");
  });

  it("Documents task keeps the single image and 'Open in Documents'", async () => {
    render(<TaskDetailView {...detailProps({ storeyName: "L1", thumb: { storagePath: t2d }, bim: null, pdf })} />);
    await screen.findByTestId("detail-location-thumb");
    expect(screen.getByTestId("detail-location-open-label").textContent).toContain("Open in Documents");
  });
});

const baseRow = {
  id: "t1",
  num: 1,
  title: "x",
  status: 20,
  updatedAt: 1,
  assigneeName: null,
  lastAction: "create",
  entryCount: 1,
};

describe("table location cell", () => {
  it("LinkView row: two compact thumbs; Models and Documents rows unchanged (one thumb)", async () => {
    localStorage.setItem("ff-task-columns", JSON.stringify(["num", "location"]));
    render(
      <TaskTablePanel
        rows={[
          { ...baseRow, id: "lv", num: 1, location: { origin: "linkview", thumb: { storagePath: t3d }, thumb2d: { storagePath: t2d }, bim, pdf }, locationThumbPath: t3d },
          { ...baseRow, id: "md", num: 2, location: { bim, pdf: null, thumb: { storagePath: t3d } }, locationThumbPath: t3d },
          { ...baseRow, id: "dc", num: 3, location: { bim: null, pdf, thumb: { storagePath: t2d } }, locationThumbPath: t2d },
        ] as never}
        now={0}
        resolvePhotoUrl={resolve}
      />,
    );
    await screen.findByTestId("ff-location-thumb-2d");
    expect(screen.getAllByTestId("ff-task-table-location-dual")).toHaveLength(1);
    expect(screen.getAllByTestId("ff-location-thumb-3d")).toHaveLength(1);
    // the two non-LinkView rows each render exactly one plain thumb
    expect(await screen.findAllByTestId("ff-location-thumb")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open in LinkView" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Open in Models" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open in Documents" })).toHaveLength(1);
  });
});

describe("task print document", () => {
  const view: PrintTaskView = {
    num: 12, title: "Crack", description: "", type: "task", status: 20, assigneeName: null, deadline: null,
    storeyName: "L1", hasBim: true, pdfPage: 1, createdBy: "A", createdAt: 1, entries: [], printedAt: "NOW",
  };
  it("prints both snapshots (plan first) when present, one when only the 3D one exists", () => {
    const both = buildTaskPrintHtml({ ...view, locationThumbUrl: "https://x/3d.jpg", locationThumb2dUrl: "https://x/2d.jpg" });
    expect(both.indexOf("https://x/2d.jpg")).toBeGreaterThan(-1);
    expect(both.indexOf("https://x/2d.jpg")).toBeLessThan(both.indexOf("https://x/3d.jpg"));
    const one = buildTaskPrintHtml({ ...view, locationThumbUrl: "https://x/3d.jpg" });
    expect(one).not.toContain("plan snapshot");
  });
});
