import { describe, expect, it } from "vitest";

import { hitTestElements } from "../../src/sheetData/hitTest";
import { parseSheetPayload } from "../../src/sheetData/sheetPayload";
import { tableToCsv } from "../../src/sheetData/tableExport";

describe("hit test: degenerate outline", () => {
  it("ignores a zero-area outline and falls back to the bbox", () => {
    const els = [
      // collinear outline: zero area. It used to win every pick (area 0).
      { gid: "line", bbox: [0, 0, 100, 100] as [number, number, number, number], outline: [[10, 10], [50, 50], [90, 90]] as Array<[number, number]> },
      { gid: "box", bbox: [0, 0, 100, 100] as [number, number, number, number] },
    ];
    // (20, 70) is inside both bboxes; the degenerate outline must not claim it by area 0
    expect(hitTestElements(els, 20, 70)!.gid).toBe("line"); // first of equal bbox areas
    const reversed = [els[1]!, els[0]!];
    expect(hitTestElements(reversed, 20, 70)!.gid).toBe("box");
  });
});

describe("CSV formula injection", () => {
  it("prefixes text cells that start with = + - @ tab or CR; leaves numbers alone", () => {
    const csv = tableToCsv({
      headers: ["a", "=h"],
      rows: [
        ["=1+1", -5],
        ["+cmd", "@SUM(A1)"],
        ["-1+2", "\tx"],
        ["ok", "1-2"],
        ["\rx", 0],
      ],
    });
    const lines = csv.replace("\uFEFF", "").split("\r\n");
    expect(lines[0]).toBe("a,'=h");
    expect(lines[1]).toBe("'=1+1,-5");
    expect(lines[2]).toBe("'+cmd,'@SUM(A1)");
    expect(lines[3]).toBe("'-1+2,'\tx");
    expect(lines[4]).toBe("ok,1-2");
    expect(csv).toContain("\"'\rx\"");
  });
});

describe("useSheetPayload does not cache transient read failures", () => {
  it("caches a definitive absence but not a thrown getAttachments", async () => {
    const { renderHook, waitFor } = await import("@testing-library/react");
    const { useSheetPayload } = await import("../../src/sheetData/useSheetPayload");
    const { clearPayloadCache, getCachedPayload } = await import("../../src/sheetData/sheetPayload");
    clearPayloadCache();
    const mk = (getAttachments: () => Promise<unknown>) =>
      ({ current: { getDocument: () => ({ getAttachments }) } }) as never;

    const failRef = mk(async () => { throw new Error("transient"); }); // stable ref: it is an effect dependency
    const failing = renderHook(() => useSheetPayload(failRef, "vFail"));
    await waitFor(() => expect(failing.result.current).toBeNull());
    expect(getCachedPayload("vFail")).toBeUndefined();

    const absentRef = mk(async () => null);
    const absent = renderHook(() => useSheetPayload(absentRef, "vAbsent"));
    await waitFor(() => expect(absent.result.current).toBeNull());
    expect(getCachedPayload("vAbsent")).toBeNull();
  });
});

describe("links to sheets that are not in the bundle (targetIncluded:false)", () => {
  const page = { widthPt: 3000, heightPt: 2000 };
  const base = { schema: "freefield.sheet/1" as const, sheetId: "s", sheetNumber: "A101", sheetName: "P", page, elementRecords: {}, schedules: [], viewports: [] };
  const payload = (links: Array<Record<string, unknown>>) =>
    parseSheetPayload(JSON.stringify({ ...base, elements: [{ gid: "D1", bbox: [500, 500, 540, 540] }], links }))!;

  it("parses targetIncluded and treats false as not navigable", async () => {
    const { isNavigableLink, notIncludedHint } = await import("../../src/sheetData/sheetLinks");
    const p = payload([
      { kind: "section", bbox: [10, 10, 50, 50], targetSheetNumber: "A901", targetIncluded: false },
      { kind: "section", bbox: [60, 10, 100, 50], targetSheetNumber: "A404" },
    ]);
    expect(p.links[0]!.targetIncluded).toBe(false);
    expect(p.links[1]!.targetIncluded).toBeUndefined();
    expect(isNavigableLink(p.links[0]!)).toBe(false);
    expect(isNavigableLink(p.links[1]!)).toBe(true);
    expect(notIncludedHint(p.links[0]!)).toBe("Sheet A901 is not in the bundle.");
  });

  it("a page-sized link to a missing sheet no longer swallows element taps", async () => {
    const { hitTestSheet } = await import("../../src/sheetData/hitTest");
    const p = payload([{ kind: "view", bbox: [90, 110, 2900, 1900], targetSheetNumber: "A901", targetIncluded: false }]);
    expect(hitTestSheet(p, 520, 520)).toMatchObject({ kind: "element" });
    expect(hitTestSheet(p, 1500, 1500)).toBeNull(); // empty drawing area: not a link hit either
  });

  it("callout REGIONS (a few % of the page) lose to elements; heads still win", async () => {
    const { hitTestSheet } = await import("../../src/sheetData/hitTest");
    const p = payload([
      { kind: "callout", bbox: [400, 400, 900, 800], targetSheetNumber: "K101" }, // ~3% region over the door below
      { kind: "elevation", bbox: [700, 700, 754, 754], targetSheetNumber: "A404" }, // 54x54 head
    ]);
    // element under a callout region: the element is picked, not the callout
    expect(hitTestSheet(p, 520, 520)).toMatchObject({ kind: "element" });
    // empty space inside the region follows the callout
    expect(hitTestSheet(p, 600, 600)).toMatchObject({ kind: "link", link: { targetSheetNumber: "K101" } });
    // a head inside the region wins
    expect(hitTestSheet(p, 720, 720)).toMatchObject({ kind: "link", link: { targetSheetNumber: "A404" } });
  });

  it("a small head wins over an element; a small missing-target head still reports (for the hint)", async () => {
    const { hitTestSheet } = await import("../../src/sheetData/hitTest");
    const p = payload([
      { kind: "section", bbox: [490, 490, 560, 560], targetSheetNumber: "A404" },
      { kind: "section", bbox: [1000, 1000, 1050, 1050], targetSheetNumber: "A901", targetIncluded: false },
    ]);
    expect(hitTestSheet(p, 520, 520)).toMatchObject({ kind: "link", link: { targetSheetNumber: "A404" } });
    expect(hitTestSheet(p, 1020, 1020)).toMatchObject({ kind: "link", link: { targetIncluded: false } });
  });
});

describe("long section lines to sheets outside the bundle", () => {
  it("report the hint when nothing else is under the finger (and lose to elements)", async () => {
    const { hitTestSheet } = await import("../../src/sheetData/hitTest");
    const page = { widthPt: 1404, heightPt: 2366 };
    const p = parseSheetPayload(JSON.stringify({
      schema: "freefield.sheet/1", sheetId: "s", sheetNumber: "V", sheetName: "V", page, viewports: [], elementRecords: {},
      elements: [{ gid: "B1", bbox: [590, 400, 620, 440] }],
      // a 57 x 1153 pt section line (2% of the page): not a head, not page-sized
      links: [{ kind: "section", bbox: [581, 209, 638, 1362], targetSheetNumber: "S-101", targetIncluded: false }],
    }))!;
    expect(hitTestSheet(p, 610, 800)).toMatchObject({ kind: "link", link: { targetIncluded: false } });
    expect(hitTestSheet(p, 600, 420)).toMatchObject({ kind: "element" });
    expect(hitTestSheet(p, 100, 100)).toBeNull();
  });
});
