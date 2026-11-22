import { describe, expect, it } from "vitest";

import { buildElementRows } from "../../src/sheetData/elementRows";
import { parseSheetPayload } from "../../src/sheetData/sheetPayload";
import {
  categoryTable,
  exportFileName,
  generalTable,
  paramCandidates,
  tableToCsv,
  toCell,
} from "../../src/sheetData/tableExport";

const rec = (gid: string, category: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  gid, uid: `u-${gid}`, category, family: "Single", type: "900", level: "L1", params, ...extra,
});

function payload(): ReturnType<typeof parseSheetPayload> {
  const mk = (v: string) => ({ d: v, k: "ALL_MODEL_MARK" });
  return parseSheetPayload(JSON.stringify({
    schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A101", sheetName: "P",
    viewports: [],
    elements: ["D1", "D2", "D3", "W1"].map((g) => ({ gid: g, bbox: [0, 0, 1, 1] })),
    elementRecords: {
      D1: rec("D1", "Doors", { Mark: mk("D-1"), Width: { d: "900" }, Height: { d: "2100" }, Fire: { d: "1h" }, Finish: { d: "Paint" }, Hardware: { d: "Set A" }, Cost: { d: "12.50" }, Category: { d: "Doors" } }),
      D2: rec("D2", "Doors", { Mark: mk("D-2"), Width: { d: "1000" }, Height: { d: "2100" }, Fire: { d: "2h" }, Finish: { d: "Stain" }, Hardware: { d: "Set B" }, Rare: { d: "x" } }),
      D3: rec("D3", "Doors", { Marca: { d: "D-3" }, Width: { d: "900" }, Height: { d: "2100" }, Fire: { d: "1h" } }),
      W1: rec("W1", "Walls", { Mark: mk("W-1"), Thickness: { d: "200" } }),
    },
    links: [],
  }));
}

describe("toCell", () => {
  it("makes plain numbers numeric and keeps everything else as text", () => {
    expect(toCell("900")).toBe(900);
    expect(toCell("-12.5")).toBe(-12.5);
    expect(toCell("12.50")).toBe("12.50"); // would not round-trip
    expect(toCell("007")).toBe("007");
    expect(toCell("1' - 0\"")).toBe("1' - 0\"");
    expect(toCell("")).toBe("");
    expect(toCell(7)).toBe(7);
    expect(toCell("12345678901234567890")).toBe("12345678901234567890");
  });
});

describe("per-category columns", () => {
  const rows = buildElementRows(payload()!);
  const doors = rows.filter((r) => r.category === "Doors");

  it("derives the mark from the mark parameter or a localised equivalent", () => {
    expect(rows.map((r) => r.mark)).toEqual(["D-1", "D-2", "D-3", "W-1"]);
  });

  it("offers the most common non-empty params, excluding marks and identity", () => {
    const c = paramCandidates(doors);
    expect(c.map((x) => x.name).slice(0, 3)).toEqual(["Fire", "Height", "Width"]);
    expect(c.find((x) => x.name === "Fire")!.count).toBe(3);
    expect(c.some((x) => /^(mark|marca|category)$/i.test(x.name))).toBe(false);
    expect(c.find((x) => x.name === "Rare")!.count).toBe(1);
  });

  it("builds Mark / Family and type / Level + chosen columns with numeric cells", () => {
    const t = categoryTable(doors, ["Width", "Fire", "Cost"]);
    expect(t.headers).toEqual(["Mark", "Family and type", "Level", "Width", "Fire", "Cost"]);
    expect(t.rows[0]).toEqual(["D-1", "Single : 900", "L1", 900, "1h", "12.50"]);
    expect(t.rows[2]![5]).toBe(""); // missing param
  });

  it("general table keeps the identity columns and sorted params", () => {
    const g = generalTable(rows);
    expect(g.headers.slice(0, 7)).toEqual(["Category", "Family", "Type", "Level", "Source element id", "Element id", "GlobalId"]);
    expect(g.rows).toHaveLength(4);
    expect(tableToCsv(categoryTable(doors, ["Width"])).split("\r\n")[1]).toBe("D-1,Single : 900,L1,900");
  });
});

describe("exportFileName", () => {
  it("names category schedules and whole-drawing exports", () => {
    expect(exportFileName("A101", "Doors", "xlsx")).toBe("Doors-schedule-A101.xlsx");
    expect(exportFileName("A101", null, "xlsx")).toBe("elements-A101.xlsx");
    expect(exportFileName("FF/101", "Armazón estructural", "csv")).toBe("Armazón_estructural-schedule-FF_101.csv");
  });
});

describe("schedules in the payload", () => {
  const base = { schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "A1", sheetName: "n", viewports: [], elements: [], elementRecords: {}, links: [] };

  it("parses placed schedules and tolerates missing / odd shapes", () => {
    expect(parseSheetPayload(JSON.stringify(base))!.schedules).toEqual([]);
    const p = parseSheetPayload(JSON.stringify({
      ...base,
      schedules: [
        { name: "Door Schedule", category: "Doors", columns: [{ heading: "Mark", paramKey: "m" }, "Width"], rows: [{ gid: "D1", uid: "u", cells: ["D-1", 900] }, { gid: "D2" }, "bad"] },
        { name: "no columns", rows: [] },
        "junk",
      ],
    }))!;
    expect(p.schedules).toHaveLength(1);
    expect(p.schedules[0]!.columns.map((c) => c.heading)).toEqual(["Mark", "Width"]);
    expect(p.schedules[0]!.rows).toEqual([{ gid: "D1", uid: "u", cells: ["D-1", 900] }]);
  });
});
