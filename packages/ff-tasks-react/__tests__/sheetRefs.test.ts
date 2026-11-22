import { describe, expect, it } from "vitest";

import {
  buildPickerSections,
  describeSheetRef,
  makeSheetRef,
  resolveSheetRefOpen,
  toggleSheetRef,
  type SheetCatalog,
} from "../src/sheetRefs";

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
  folders: [
    { id: "arc", parentId: null, name: "ARC" },
    { id: "arc-p", parentId: "arc", name: "Plans" },
    { id: "str", parentId: null, name: "STR" },
  ],
  assignments: new Map([
    ["f1", "arc-p"],
    ["f2", "str"],
  ]),
};

describe("makeSheetRef", () => {
  it("references the sheet's latest version by id (no copy)", () => {
    expect(makeSheetRef("f1", catalog)).toEqual({
      pdfFileId: "f1",
      pdfVersionId: "f1v2",
      versionNumber: 2,
      name: "A101 - First Floor.pdf",
    });
  });
  it("can reference a chosen older version and a page", () => {
    expect(makeSheetRef("f1", catalog, { versionId: "f1v1", page: 3 })).toMatchObject({ pdfVersionId: "f1v1", versionNumber: 1, page: 3 });
  });
  it("returns null for an unknown sheet", () => {
    expect(makeSheetRef("nope", catalog)).toBeNull();
  });
});

describe("describeSheetRef — version badge", () => {
  it("current version", () => {
    expect(describeSheetRef({ pdfFileId: "f1", pdfVersionId: "f1v2", versionNumber: 2, name: "x" }, catalog)).toMatchObject({
      status: "current",
      label: "v2",
      name: "A101 - First Floor.pdf",
    });
  });
  it("superseded: 'v1 (newer: v2)'", () => {
    expect(describeSheetRef({ pdfFileId: "f1", pdfVersionId: "f1v1", versionNumber: 1, name: "x" }, catalog)).toMatchObject({
      status: "superseded",
      label: "v1 (newer: v2)",
      latestVersionId: "f1v2",
    });
  });
  it("missing sheet keeps the stored name and says so", () => {
    expect(describeSheetRef({ pdfFileId: "gone", pdfVersionId: "gv", versionNumber: 1, name: "Old.pdf" }, catalog)).toMatchObject({
      status: "missing",
      name: "Old.pdf",
      label: "removed",
    });
  });
  it("missing version of an existing sheet falls to the latest label", () => {
    expect(describeSheetRef({ pdfFileId: "f1", pdfVersionId: "ghost", versionNumber: 5, name: "x" }, catalog)).toMatchObject({
      status: "version-missing",
      latestVersionId: "f1v2",
    });
  });
});

describe("resolveSheetRefOpen — opens the CHOSEN version", () => {
  it("opens the chosen (superseded) version, not the latest", () => {
    const r = resolveSheetRefOpen({ pdfFileId: "f1", pdfVersionId: "f1v1", versionNumber: 1, name: "x", page: 2 }, catalog);
    expect(r).toMatchObject({ ok: true, intent: { kind: "documents", pdfFileId: "f1", versionId: "f1v1", buildingId: "bA", page: 2, uv: null } });
  });
  it("a deleted version falls back to the latest with a message", () => {
    const r = resolveSheetRefOpen({ pdfFileId: "f1", pdfVersionId: "ghost", name: "x" }, catalog);
    expect(r).toMatchObject({ ok: true, intent: { versionId: "f1v2", page: 1 } });
    expect((r as { notice: string }).notice).toMatch(/no longer exists/);
  });
  it("a deleted sheet is a clear message", () => {
    const r = resolveSheetRefOpen({ pdfFileId: "gone", pdfVersionId: "v", name: "Old.pdf" }, catalog);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).toMatch(/Old\.pdf/);
  });
});

describe("toggleSheetRef", () => {
  const a = { pdfFileId: "f1", pdfVersionId: "f1v2", versionNumber: 2, name: "A" };
  const b = { pdfFileId: "f2", pdfVersionId: "f2v1", versionNumber: 1, name: "B" };
  it("adds then removes the same sheet", () => {
    const one = toggleSheetRef([], a);
    expect(one).toEqual([a]);
    expect(toggleSheetRef([a, b], a)).toEqual([b]);
  });
  it("a different version of the same sheet is a separate attachment", () => {
    const old = { ...a, pdfVersionId: "f1v1", versionNumber: 1 };
    expect(toggleSheetRef([a], old)).toEqual([a, old]);
  });
});

describe("buildPickerSections — folders, search, building", () => {
  it("groups by folder path (nested), then Unfiled; only the building's sheets", () => {
    const s = buildPickerSections(catalog, { buildingId: "bA", query: "" });
    expect(s.map((x) => x.title)).toEqual(["ARC / Plans", "STR"]);
    expect(s[0].entries[0]).toMatchObject({ fileId: "f1", badge: "v2/2" });
    expect(s[1].entries[0]).toMatchObject({ fileId: "f2", badge: "v1/1" });
  });
  it("no building filter lists the whole project, unassigned sheets under Unfiled", () => {
    const s = buildPickerSections(catalog, { buildingId: null, query: "" });
    expect(s.map((x) => x.title)).toEqual(["ARC / Plans", "STR", "Unfiled"]);
    expect(s[2].entries[0].fileId).toBe("f3");
  });
  it("search matches the file name or folder, case-insensitively, and drops empty sections", () => {
    expect(buildPickerSections(catalog, { buildingId: "bA", query: "framing" }).map((x) => x.title)).toEqual(["STR"]);
    expect(buildPickerSections(catalog, { buildingId: "bA", query: "arc" }).map((x) => x.entries[0].fileId)).toEqual(["f1"]);
    expect(buildPickerSections(catalog, { buildingId: "bA", query: "zzz" })).toEqual([]);
  });
});
