// The minimal XLSX writer (Documents module) produces a real zip that jszip
// can open, with the right parts, and text / numbers round-trip.
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { buildXlsx, columnName, sanitizeSheetName } from "../../../documents/src/sheetData/xlsx";
import { crc32 } from "../../../documents/src/sheetData/zipStore";

/** Tiny reader for the writer's own output: values by cell reference. */
async function readBack(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const sst = await zip.file("xl/sharedStrings.xml")!.async("string");
  const strings = [...sst.matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map((m) =>
    m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"),
  );
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  const cells = new Map<string, { value: string | number; style: string | null }>();
  for (const m of sheet.matchAll(/<c r="([A-Z]+\d+)"([^>]*)><v>([^<]*)<\/v><\/c>/g)) {
    const attrs = m[2]!;
    const isStr = /t="s"/.test(attrs);
    cells.set(m[1]!, {
      value: isStr ? strings[Number(m[3])]! : Number(m[3]),
      style: /s="(\d+)"/.exec(attrs)?.[1] ?? null,
    });
  }
  return { zip, sheet, strings, cells };
}

describe("buildXlsx", () => {
  const bytes = buildXlsx({
    sheetName: "Doors: 1/2",
    headers: ["Mark", "Width", "Note"],
    rows: [
      ["D-1", 0.9, 'He said "hi" & <left>'],
      ["D-2", 1200, "Ünïcode ✓"],
      ["D-1", 42, ""],
    ],
  });

  it("is a valid zip with the SpreadsheetML parts", async () => {
    const { zip } = await readBack(bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    const wb = await zip.file("xl/workbook.xml")!.async("string");
    expect(wb).toContain('<sheet name="Doors 1 2"');
    // The stored entries pass jszip's CRC check on read (async() would throw otherwise).
    expect(await zip.file("[Content_Types].xml")!.async("string")).toContain("spreadsheetml.worksheet+xml");
  });

  it("round-trips text through shared strings and numbers as numeric cells", async () => {
    const { cells, strings, sheet } = await readBack(bytes);
    expect(cells.get("A1")).toEqual({ value: "Mark", style: "1" }); // bold header
    expect(cells.get("C1")!.style).toBe("1");
    expect(cells.get("A2")).toEqual({ value: "D-1", style: null });
    expect(cells.get("B2")).toEqual({ value: 0.9, style: null });
    expect(cells.get("B3")).toEqual({ value: 1200, style: null });
    expect(cells.get("B4")!.value).toBe(42);
    expect(cells.get("C2")!.value).toBe('He said "hi" & <left>');
    expect(cells.get("C3")!.value).toBe("Ünïcode ✓");
    expect(cells.has("C4")).toBe(false); // empty -> no cell
    // numbers are not shared strings, repeated text is shared once
    expect(sheet).toMatch(/<c r="B2"><v>0.9<\/v><\/c>/);
    expect(strings.filter((s) => s === "D-1")).toHaveLength(1);
    expect(sheet).toContain('<dimension ref="A1:C4"/>');
    expect(sheet).toContain('state="frozen"');
  });

  it("helpers", () => {
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
    expect(sanitizeSheetName("a".repeat(40)).length).toBe(31);
    expect(sanitizeSheetName("")).toBe("Sheet1");
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});
