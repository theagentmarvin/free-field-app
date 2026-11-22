// The Elements panel (categories with counts; picking a category selects all its
// instances) and the Schedules panel. The CSV / XLSX buttons are not in the UI.
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import ElementsPanelBody from "../../src/sheetData/ElementsPanelBody";
import PropertiesPanelBody from "../../src/sheetData/PropertiesPanelBody";
import SchedulesPanelBody from "../../src/sheetData/SchedulesPanelBody";
import { gidsOfCategory, useSheetDataStore } from "../../src/sheetData/sheetDataStore";
import { parseSheetPayload } from "../../src/sheetData/sheetPayload";

const json = {
  schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A101", sheetName: "Plan", viewports: [],
  elements: [
    { gid: "D1", bbox: [100, 100, 140, 140] },
    { gid: "D2", bbox: [200, 100, 240, 140] },
    { gid: "D2", bbox: [210, 300, 250, 340] }, // the same door drawn in a second view
    { gid: "W1", bbox: [300, 100, 340, 140] },
  ],
  elementRecords: {
    D1: { gid: "D1", category: "Doors", family: "Single", type: "900", level: "L1", params: { Mark: { d: "D-1", k: "ALL_MODEL_MARK" } } },
    D2: { gid: "D2", category: "Doors", family: "Single", type: "1000", level: "L1", params: {} },
    W1: { gid: "W1", category: "Walls", params: {} },
  },
  links: [],
  schedules: [
    { name: "Door Schedule", category: "Doors", columns: [{ heading: "Mark" }, { heading: "Width" }],
      rows: [{ gid: "D1", cells: ["D-1", 900] }, { gid: "D2", cells: ["D-2", 1000] }, { gid: "NOT-DRAWN", cells: ["D-9", 1] }] },
  ],
};

beforeEach(() => {
  useSheetDataStore.setState({ payload: parseSheetPayload(JSON.stringify(json)), selectedGids: [], selectedCategory: null });
});

describe("Elements panel", () => {
  it("lists categories with counts (distinct elements), no export buttons", () => {
    render(<ElementsPanelBody />);
    const cats = screen.getAllByTestId("elements-category").map((c) => c.textContent);
    expect(cats).toEqual(["Doors2", "Walls1"]);
    expect(screen.queryByTestId("elements-download-csv")).toBeNull();
    expect(screen.queryByTestId("elements-download-xlsx")).toBeNull();
    expect(screen.queryByText(/Download/)).toBeNull();
  });

  it("clicking a category selects ALL its instances; again clears; another switches", () => {
    render(<ElementsPanelBody />);
    const doors = screen.getAllByTestId("elements-category")[0]!;
    fireEvent.click(doors);
    expect(useSheetDataStore.getState().selectedGids).toEqual(["D1", "D2"]);
    expect(useSheetDataStore.getState().selectedCategory).toBe("Doors");
    expect(doors.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getAllByTestId("elements-category")[1]!); // Walls
    expect(useSheetDataStore.getState().selectedGids).toEqual(["W1"]);
    fireEvent.click(screen.getAllByTestId("elements-category")[1]!); // Walls again
    expect(useSheetDataStore.getState().selectedGids).toEqual([]);
    expect(useSheetDataStore.getState().selectedCategory).toBeNull();
  });

  it("an individual element shows its properties (and tells the host)", () => {
    let picked = 0;
    render(<><ElementsPanelBody onElementPicked={() => { picked += 1; }} /><PropertiesPanelBody /></>);
    fireEvent.click(screen.getAllByTestId("elements-category")[0]!); // expand Doors
    expect(screen.getByTestId("properties-multi").textContent).toContain("2 Doors selected");
    fireEvent.click(screen.getAllByTestId("elements-row")[0]!);
    expect(useSheetDataStore.getState().selectedGids).toEqual(["D1"]);
    expect(useSheetDataStore.getState().selectedCategory).toBeNull();
    expect(picked).toBe(1);
    expect(screen.getByTestId("element-properties").textContent).toContain("Doors");
  });

  it("gidsOfCategory returns distinct ids", () => {
    expect(gidsOfCategory(useSheetDataStore.getState().payload!, "Doors")).toEqual(["D1", "D2"]);
    expect(gidsOfCategory(useSheetDataStore.getState().payload!, "Nothing")).toEqual([]);
  });
});

describe("Schedules panel", () => {
  it("lists the schedules, opens one, rows select drawn elements only, no export buttons", () => {
    render(<SchedulesPanelBody />);
    const item = screen.getByTestId("schedule-item");
    expect(item.textContent).toContain("Door Schedule");
    fireEvent.click(item);
    const rows = screen.getAllByTestId("schedule-row");
    expect(rows).toHaveLength(3);
    fireEvent.click(rows[1]!);
    expect(useSheetDataStore.getState().selectedGids).toEqual(["D2"]);
    fireEvent.click(rows[2]!); // not drawn on this sheet: ignored
    expect(useSheetDataStore.getState().selectedGids).toEqual(["D2"]);
    expect(screen.queryByText(/Download/)).toBeNull();
    fireEvent.click(screen.getByTestId("schedules-back"));
    expect(screen.getByTestId("schedules-list")).toBeTruthy();
  });
});
