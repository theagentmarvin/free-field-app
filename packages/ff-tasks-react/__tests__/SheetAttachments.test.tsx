// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";

import type { SheetRef } from "@ff/tasks";

const openSheetRef = vi.fn();
vi.mock("../src/sheetCatalog", async (orig) => ({
  ...(await orig<typeof import("../src/sheetCatalog")>()),
  openSheetRef: (...a: unknown[]) => openSheetRef(...a),
}));

import { SheetChips, SheetPicker } from "../src/SheetAttachments";
import { TaskDetailView, type TaskDetailViewProps } from "../src/TaskDetailView";
import type { SheetCatalog } from "../src/sheetRefs";

const catalog: SheetCatalog = {
  files: new Map([
    ["f1", { id: "f1", buildingId: "bA", name: "A101 - First Floor.pdf" }],
    ["f2", { id: "f2", buildingId: "bA", name: "S201 - Framing.pdf" }],
    ["f3", { id: "f3", buildingId: "bB", name: "M301 - Mech.pdf" }],
  ]),
  versions: [
    { id: "f1v1", pdfFileId: "f1", versionNumber: 1, isLatest: false },
    { id: "f1v2", pdfFileId: "f1", versionNumber: 2, isLatest: true },
    { id: "f2v1", pdfFileId: "f2", versionNumber: 1, isLatest: true },
    { id: "f3v1", pdfFileId: "f3", versionNumber: 1, isLatest: true },
  ],
  folders: [{ id: "arc", parentId: null, name: "ARC" }],
  assignments: new Map([["f1", "arc"]]),
};

afterEach(() => {
  cleanup();
  openSheetRef.mockClear();
});

function Harness({ initial = [] as SheetRef[], onList }: { initial?: SheetRef[]; onList?: (l: SheetRef[]) => void }) {
  const [list, setList] = useState<SheetRef[]>(initial);
  return (
    <SheetPicker
      projectId="p"
      buildingId="bA"
      catalog={catalog}
      selected={list}
      onChange={(n) => {
        setList(n);
        onList?.(n);
      }}
      onClose={() => {}}
    />
  );
}

describe("SheetPicker", () => {
  it("lists the building's sheets in folders with version badges", () => {
    render(<Harness />);
    const sections = screen.getAllByTestId("sheet-picker-section");
    expect(sections.map((s) => within(s).getByText(/ARC|Unfiled/).textContent)).toEqual(["ARC", "Unfiled"]);
    expect(screen.getAllByTestId("sheet-picker-row")).toHaveLength(2); // the other building's sheet is not offered
    expect(screen.getAllByTestId("sheet-picker-badge").map((b) => b.textContent)).toEqual(["v2/2", "v1/1"]);
  });

  it("search filters; an empty result says so", () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId("sheet-picker-search"), { target: { value: "framing" } });
    expect(screen.getAllByTestId("sheet-picker-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("sheet-picker-search"), { target: { value: "zzz" } });
    expect(screen.getByTestId("sheet-picker-empty")).toBeTruthy();
  });

  it("multi-select stores references (file + version, no copy) and can unselect", () => {
    const seen: SheetRef[][] = [];
    render(<Harness onList={(l) => seen.push(l)} />);
    const rows = screen.getAllByTestId("sheet-picker-row");
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(seen[1]).toEqual([
      { pdfFileId: "f1", pdfVersionId: "f1v2", versionNumber: 2, name: "A101 - First Floor.pdf" },
      { pdfFileId: "f2", pdfVersionId: "f2v1", versionNumber: 1, name: "S201 - Framing.pdf" },
    ]);
    expect(screen.getByTestId("sheet-picker-count").textContent).toBe("2 attached");
    fireEvent.click(rows[0]);
    expect(seen[2].map((r) => r.pdfFileId)).toEqual(["f2"]);
  });
});

describe("SheetChips", () => {
  const superseded: SheetRef = { pdfFileId: "f1", pdfVersionId: "f1v1", versionNumber: 1, name: "A101 - First Floor.pdf" };
  const gone: SheetRef = { pdfFileId: "zzz", pdfVersionId: "v", versionNumber: 1, name: "Old.pdf" };

  it("shows 'v1 (newer: v2)' and opens the chosen version's sheet; removed sheets are inert", () => {
    render(<SheetChips refs={[superseded, gone]} catalog={catalog} projectId="p" />);
    const chips = screen.getAllByTestId("sheet-chip");
    expect(within(chips[0]).getByTestId("sheet-chip-badge").textContent).toBe("v1 (newer: v2)");
    expect(within(chips[1]).getByTestId("sheet-chip-badge").textContent).toBe("removed");
    fireEvent.click(within(chips[0]).getByTestId("sheet-chip-open"));
    expect(openSheetRef).toHaveBeenCalledWith(superseded, "p");
    expect((within(chips[1]).getByTestId("sheet-chip-open") as HTMLButtonElement).disabled).toBe(true);
  });

  it("remove only appears when removable and calls back with the reference", () => {
    const onRemove = vi.fn();
    const { rerender } = render(<SheetChips refs={[superseded]} catalog={catalog} projectId="p" />);
    expect(screen.queryByTestId("sheet-chip-remove")).toBeNull();
    rerender(<SheetChips refs={[superseded]} catalog={catalog} projectId="p" onRemove={onRemove} />);
    fireEvent.click(screen.getByTestId("sheet-chip-remove"));
    expect(onRemove).toHaveBeenCalledWith(superseded);
  });
});

function viewProps(over: Partial<TaskDetailViewProps> = {}): TaskDetailViewProps {
  return {
    num: 12,
    title: "Set door frame",
    description: "",
    status: 20,
    assigneeName: "Ada",
    deadline: null,
    location: null,
    entries: [],
    canAct: true,
    onComment: vi.fn(),
    onTransition: vi.fn(),
    onRetryEntry: vi.fn(),
    onClose: vi.fn(),
    extendedFields: true,
    editable: true,
    sheetCatalog: catalog,
    projectId: "p",
    buildingId: "bA",
    onEditFields: vi.fn(),
    ...over,
  };
}

describe("TaskDetailView — sheets", () => {
  const ref: SheetRef = { pdfFileId: "f1", pdfVersionId: "f1v2", versionNumber: 2, name: "A101 - First Floor.pdf" };

  it("lists attached sheets, supports several, and removing one edits the list", () => {
    const p = viewProps({ sheetRefs: [ref, { pdfFileId: "f2", pdfVersionId: "f2v1", versionNumber: 1, name: "S201" }] });
    render(<TaskDetailView {...p} />);
    expect(screen.getAllByTestId("sheet-chip")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("sheet-chip-remove")[0]);
    expect(p.onEditFields).toHaveBeenCalledWith({ sheetRefs: [expect.objectContaining({ pdfFileId: "f2" })] });
  });

  it("'Attach from project' opens the picker and attaching enqueues the edit", () => {
    const p = viewProps({ sheetRefs: [ref] });
    render(<TaskDetailView {...p} />);
    fireEvent.click(screen.getByTestId("detail-attach-from-project"));
    fireEvent.click(screen.getAllByTestId("sheet-picker-row").find((r) => r.getAttribute("data-file-id") === "f2")!);
    expect(p.onEditFields).toHaveBeenCalledWith({
      sheetRefs: [ref, expect.objectContaining({ pdfFileId: "f2", pdfVersionId: "f2v1" })],
    });
  });

  it("read-only (terminal) tasks show the chips but no attach / remove", () => {
    render(<TaskDetailView {...viewProps({ editable: false, sheetRefs: [ref] })} />);
    expect(screen.getByTestId("sheet-chip")).toBeTruthy();
    expect(screen.queryByTestId("detail-attach-from-project")).toBeNull();
    expect(screen.queryByTestId("sheet-chip-remove")).toBeNull();
  });

  it("hidden when extended fields are off and nothing is attached", () => {
    render(<TaskDetailView {...viewProps({ extendedFields: false })} />);
    expect(screen.queryByTestId("detail-zone-sheets")).toBeNull();
  });
});
