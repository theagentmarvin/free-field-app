import { describe, expect, it } from "vitest";

import {
  buildElementRows,
  categoryCounts,
  filterRows,
  toCsv,
} from "../../src/sheetData/elementRows";
import { hitTestElements, hitTestLinks, hitTestSheet, pointInPolygon } from "../../src/sheetData/hitTest";
import {
  findSheetPdf,
  isNavigableLink,
  resolveLinkTarget,
  resolveSheetPdf,
  exactNumberCandidates,
} from "../../src/sheetData/sheetLinks";
import {
  clearPayloadCache,
  getCachedPayload,
  parseSheetPayload,
  readSheetPayload,
  setCachedPayload,
  type SheetPayload,
} from "../../src/sheetData/sheetPayload";

function payloadJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "freefield.sheet/1",
    sheetId: "s1",
    sheetNumber: "A101",
    sheetName: "Plan",
    viewports: [],
    elements: [
      { gid: "W1", vp: "v", bbox: [100, 100, 300, 140] },
      { gid: "D1", vp: "v", bbox: [180, 95, 220, 145] }, // door inside the wall box
      { gid: "R1", vp: "v", bbox: [90, 90, 400, 300] }, // room around everything
      { gid: "L1", vp: "v", bbox: [500, 500, 600, 600], outline: [[500, 500], [600, 500], [500, 600]] },
    ],
    elementRecords: {
      W1: { uid: "u-w1", eid: 11, gid: "W1", category: "Walls", family: "Basic Wall", type: "200", level: "Level 1", params: { Mark: { v: "W-1", d: "W-1" }, Width: { v: 0.2, d: "200 mm", u: "mm", t: true } } },
      D1: { uid: "u-d1", gid: "D1", category: "Doors", family: "Single", type: "900", level: "Level 1", params: { Mark: { d: "D, \"1\"" } } },
      R1: { gid: "R1", category: "Rooms", params: {} },
    },
    links: [
      { kind: "section", bbox: [10, 10, 50, 50], targetSheetId: "s2", targetSheetNumber: "A201", targetViewId: "v9" },
      { kind: "view", bbox: [60, 10, 100, 50], targetSheetId: null, targetSheetNumber: null },
    ],
    ...over,
  });
}

describe("parseSheetPayload", () => {
  it("parses a valid payload", () => {
    const p = parseSheetPayload(payloadJson())!;
    expect(p.sheetNumber).toBe("A101");
    expect(p.elements).toHaveLength(4);
    expect(p.elementRecords.W1!.params.Mark!.d).toBe("W-1");
    expect(p.links[1]!.targetSheetNumber).toBeNull();
  });

  it("accepts bytes and normalises reversed boxes", () => {
    const bytes = new TextEncoder().encode(payloadJson({ elements: [{ gid: "X", bbox: [10, 20, 2, 4] }] }));
    expect(parseSheetPayload(bytes)!.elements[0]!.bbox).toEqual([2, 4, 10, 20]);
  });

  it("rejects other schemas and junk, drops malformed entries", () => {
    expect(parseSheetPayload("{nope")).toBeNull();
    expect(parseSheetPayload(JSON.stringify({ schema: "x/1" }))).toBeNull();
    expect(parseSheetPayload("[]")).toBeNull();
    const p = parseSheetPayload(payloadJson({ elements: [{ gid: 1, bbox: [0, 0, 1, 1] }, { gid: "ok", bbox: [0, 0, 1, 1] }, { gid: "bad", bbox: [0, 0] }] }))!;
    expect(p.elements.map((e) => e.gid)).toEqual(["ok"]);
  });
});

describe("readSheetPayload + cache", () => {
  it("reads the attachment by name or filename; null when absent", async () => {
    const content = new TextEncoder().encode(payloadJson());
    expect((await readSheetPayload({ getAttachments: async () => ({ "freefield-sheet.json": { content } }) }))!.sheetId).toBe("s1");
    expect((await readSheetPayload({ getAttachments: async () => ({ x: { filename: "freefield-sheet.json", content } }) }))!.sheetId).toBe("s1");
    expect(await readSheetPayload({ getAttachments: async () => null })).toBeNull();
    expect(await readSheetPayload({ getAttachments: async () => ({ "other.txt": { content } }) })).toBeNull();
    // a failed read is NOT "no data": undefined, so callers do not cache it
    expect(await readSheetPayload({ getAttachments: async () => { throw new Error("x"); } })).toBeUndefined();
  });

  it("caches per version (including a negative result)", () => {
    clearPayloadCache();
    expect(getCachedPayload("v1")).toBeUndefined();
    setCachedPayload("v1", null);
    expect(getCachedPayload("v1")).toBeNull();
    const p = parseSheetPayload(payloadJson())!;
    setCachedPayload("v2", p);
    expect(getCachedPayload("v2")).toBe(p);
  });
});

describe("hit testing", () => {
  const p = parseSheetPayload(payloadJson())!;

  it("picks the smallest containing bbox", () => {
    expect(hitTestElements(p.elements, 200, 120)!.gid).toBe("D1"); // door inside wall inside room
    expect(hitTestElements(p.elements, 120, 120)!.gid).toBe("W1");
    expect(hitTestElements(p.elements, 350, 250)!.gid).toBe("R1");
    expect(hitTestElements(p.elements, 5, 5)).toBeNull();
  });

  it("prefers the exact outline over the bbox", () => {
    // inside the bbox of L1 but outside its triangle
    expect(hitTestElements(p.elements, 590, 590)).toBeNull();
    expect(hitTestElements(p.elements, 510, 510)!.gid).toBe("L1");
    expect(pointInPolygon(1, 1, [[0, 0], [4, 0], [0, 4]])).toBe(true);
    expect(pointInPolygon(3, 3, [[0, 0], [4, 0], [0, 4]])).toBe(false);
  });

  it("reference heads win over elements", () => {
    expect(hitTestLinks(p.links, 20, 20)!.targetSheetNumber).toBe("A201");
    const hit = hitTestSheet({ ...p, page: { widthPt: 3000, heightPt: 2000 }, elements: [{ gid: "E", bbox: [0, 0, 100, 100] }] }, 20, 20);
    expect(hit?.kind).toBe("link");
    expect(hitTestSheet(p, 120, 120)?.kind).toBe("element");
    expect(hitTestSheet(p, 5, 700)).toBeNull();
  });
});

describe("link resolution", () => {
  const pdfs = [
    { pdfFileId: "f1", name: "A101 - First Floor Plan.pdf", versionId: "v1" },
    { pdfFileId: "f2", name: "A201 - Sections.pdf", versionId: "v2" },
    { pdfFileId: "f3", name: "A - 101 - Plan.pdf", versionId: "v3" },
    { pdfFileId: "f4", name: "G001.pdf", versionId: "v4" },
    { pdfFileId: "f5", name: "a201 - Other.pdf", versionId: "v5" },
    { pdfFileId: "f6", name: "A - Plan.pdf", versionId: "v6" },
  ];

  it("matches the exact sanitised number (case sensitive), not a prefix guess", () => {
    expect(findSheetPdf("A201", pdfs)!.versionId).toBe("v2");
    expect(findSheetPdf("a201", pdfs)!.versionId).toBe("v5"); // not the A201 PDF
    expect(findSheetPdf(" A201 ", pdfs)!.versionId).toBe("v2");
    expect(findSheetPdf("G001", pdfs)!.versionId).toBe("v4");
    expect(findSheetPdf("A/B", [{ pdfFileId: "x", name: "A_B - Plan.pdf", versionId: "vx" }])!.versionId).toBe("vx");
    expect(findSheetPdf("Z999", pdfs)).toBeNull();
    expect(findSheetPdf(null, pdfs)).toBeNull();
    expect(findSheetPdf("A2", pdfs)).toBeNull(); // no prefix-only hit
  });

  it("uses the embedded sheet number to disambiguate (numbers containing ' - ')", async () => {
    const embedded: Record<string, string | null | undefined> = { v3: "A - 101", v6: "A", v1: "A101" };
    const read = async (id: string) => embedded[id];
    // "A" has two filename candidates ("A - 101 - Plan" and "A - Plan"): payload picks the right one
    expect((await resolveSheetPdf("A", pdfs, read))!.versionId).toBe("v6");
    expect((await resolveSheetPdf("A - 101", pdfs, read))!.versionId).toBe("v3");
    // the embedded number rejects a same-prefix PDF of another sheet
    expect(await resolveSheetPdf("A101", [{ pdfFileId: "f", name: "A101 - Imposter.pdf", versionId: "vz" }], async () => "B1")).toBeNull();
  });

  it("falls back to the exact filename only when no embedded number is readable", async () => {
    const plain = async () => null;
    expect((await resolveSheetPdf("A201", pdfs, plain))!.versionId).toBe("v2");
    const unreadable = async () => undefined;
    expect((await resolveSheetPdf("A201", pdfs, unreadable))!.versionId).toBe("v2");
    expect(exactNumberCandidates("A201", pdfs).map((p) => p.versionId)).toEqual(["v2"]);
  });

  it("treats links without a target sheet as not navigable", () => {
    const view = { kind: "view", bbox: [0, 0, 1, 1] as [number, number, number, number], targetSheetNumber: null };
    expect(isNavigableLink(view)).toBe(false);
    expect(resolveLinkTarget(view, pdfs)).toBeNull();
    expect(resolveLinkTarget({ ...view, targetSheetNumber: "A101" }, pdfs)!.versionId).toBe("v1");
  });
});

describe("elements table + CSV", () => {
  const p = parseSheetPayload(payloadJson({ elements: [
    { gid: "W1", bbox: [0, 0, 1, 1] }, { gid: "W1", bbox: [5, 5, 6, 6] }, { gid: "D1", bbox: [0, 0, 1, 1] }, { gid: "NOREC", bbox: [0, 0, 1, 1] },
  ] }))! as SheetPayload;

  it("builds one row per element and counts categories", () => {
    const rows = buildElementRows(p);
    expect(rows.map((r) => r.gid)).toEqual(["W1", "D1", "NOREC"]);
    expect(rows[2]!.category).toBe("Other");
    expect(categoryCounts(rows)).toEqual([
      { category: "Doors", count: 1 },
      { category: "Other", count: 1 },
      { category: "Walls", count: 1 },
    ]);
  });

  it("filters by category and search text", () => {
    const rows = buildElementRows(p);
    expect(filterRows(rows, new Set(["Walls"])).map((r) => r.gid)).toEqual(["W1"]);
    expect(filterRows(rows, new Set(), "single").map((r) => r.gid)).toEqual(["D1"]);
    expect(filterRows(rows, new Set(["Walls"]), "single")).toEqual([]);
    expect(filterRows(rows, new Set())).toHaveLength(3);
  });

  it("writes RFC 4180 CSV for the filtered rows", () => {
    const rows = buildElementRows(p);
    const csv = toCsv(filterRows(rows, new Set(["Doors", "Walls"])));
    const lines = csv.replace("\uFEFF", "").trimEnd().split("\r\n");
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(lines[0]).toBe("Category,Family,Type,Level,Source element id,Element id,GlobalId,Mark,Width");
    expect(lines[1]).toBe("Walls,Basic Wall,200,Level 1,u-w1,11,W1,W-1,200 mm");
    expect(lines[2]).toBe('Doors,Single,900,Level 1,u-d1,,D1,"D, ""1""",');
    expect(lines).toHaveLength(3);
  });
});

