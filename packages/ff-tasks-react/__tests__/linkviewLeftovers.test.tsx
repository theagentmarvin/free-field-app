// @vitest-environment jsdom
// LinkView leftovers: (1) the compose sheet names the stamped building when the
// host passes no building list; (2) the HTML report prints plan + 3D side by side.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@ff/auth", () => ({
  useProjectId: () => "p1",
  requireProjectId: (id?: string) => id,
  useRole: () => "admin",
  useAuthContext: () => ({ isDemo: true }),
}));
vi.mock("@ff/data/db/database", () => ({ db: { outbox: {}, drafts: {} } }));
vi.mock("dexie-react-hooks", () => ({
  // every live query in the sheet resolves to the project's building rows
  useLiveQuery: () => [{ id: "b1", name: "Tower A" }],
}));

import { TaskComposeSheet } from "../src/TaskComposeSheet";
import { buildTasksReportHtml, type ReportTask } from "../src/exportTasks";

describe("compose sheet building chip (LinkView origin)", () => {
  it("shows the building name, not only Cross-building, with no buildings prop", () => {
    render(
      <TaskComposeSheet
        projectId="p1"
        taskId="t1"
        actor={{ uid: "u1", name: "Ana" }}
        members={[]}
        engine={{ enqueue: vi.fn() } as never}
        draftTable={{ get: async () => undefined, put: async () => {}, delete: async () => {}, whereProject: async () => [] } as never}
        location={{ origin: "linkview", bim: { worldPoint: [0, 0, 0], elements: [] }, pdf: { pdfFileId: "f1" } } as never}
        buildingId="b1"
        onDone={() => {}}
        onClose={() => {}}
      />
    );
    const chip = screen.getByTestId("compose-building-b1");
    expect(chip.textContent).toBe("Tower A");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("compose-building-none").getAttribute("aria-pressed")).toBe("false");
  });
});

function item(id: string, location: unknown, thumb: string | null, thumb2d: string | null): ReportTask {
  return {
    row: { id, num: 1, title: id, status: 10, location } as never,
    photoUrls: [],
    locationThumbUrl: thumb,
    locationThumb2dUrl: thumb2d,
  };
}
const dual = {
  origin: "linkview",
  bim: { elements: [] },
  pdf: { pdfFileId: "f1" },
  thumb: { storagePath: "a/3d.jpg" },
  thumb2d: { storagePath: "a/2d.jpg" },
};

describe("HTML report location images", () => {
  const html = (items: ReportTask[]) => buildTasksReportHtml(items, { now: 1 });
  it("prints plan and 3D for a dual-thumb task", () => {
    const out = html([item("lv", dual, "u3d", "u2d")]);
    expect(out).toContain('src="u2d"');
    expect(out).toContain('src="u3d"');
    expect(out.indexOf('src="u2d"')).toBeLessThan(out.indexOf('src="u3d"'));
  });
  it("prints one image for a non-LinkView task", () => {
    const out = html([item("m", { thumb: { storagePath: "a/3d.jpg" } }, "u3d", null)]);
    expect(out).toContain('src="u3d"');
    expect((out.match(/class="loc/g) ?? []).length).toBe(1);
  });
  it("prints one image when a LinkView task lacks the plan thumb", () => {
    const out = html([item("lv", { origin: "linkview", bim: {}, pdf: {}, thumb: { storagePath: "a/3d.jpg" } }, "u3d", null)]);
    expect((out.match(/class="loc/g) ?? []).length).toBe(1);
  });
});
