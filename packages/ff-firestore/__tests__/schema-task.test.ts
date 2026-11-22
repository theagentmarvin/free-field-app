/**
 * Tasks UI refresh v1 (§2 data delta): `TaskSchema.buildingId` is
 * additive and backfillable. Pure zod unit test — no emulator — so it
 * runs in the default node environment.
 */

import { describe, expect, it } from "vitest";

import { TaskSchema } from "../src/schema/task";

const baseDoc = () => ({
  id: "t1",
  num: 1,
  title: "Crack in slab",
  description: "",
  type: "task",
  status: 10,
  createdBy: "Ana",
  createdByUid: "u1",
  createdAt: 1_700_000_000_000,
  updatedBy: "Ana",
  updatedAt: 1_700_000_000_000,
  assigneeUid: null,
  assigneeName: null,
  deadline: null,
  location: null,
  photos: [],
  lastAction: "create" as const,
  entryCount: 1,
});

describe("TaskSchema · buildingId (UI-refresh v1)", () => {
  it("defaults a legacy doc (no buildingId key) to null", () => {
    const parsed = TaskSchema.parse(baseDoc());
    expect(parsed.buildingId).toBeNull();
  });

  it("round-trips an explicit building id", () => {
    const parsed = TaskSchema.parse({ ...baseDoc(), buildingId: "b-12" });
    expect(parsed.buildingId).toBe("b-12");
  });

  it("accepts an explicit null (cross-building task)", () => {
    const parsed = TaskSchema.parse({ ...baseDoc(), buildingId: null });
    expect(parsed.buildingId).toBeNull();
  });

  it("rejects non-string, non-null values", () => {
    expect(TaskSchema.safeParse({ ...baseDoc(), buildingId: 42 }).success).toBe(false);
  });
});

describe("TaskSchema · location.pdf (w72)", () => {
  const pdfLoc = (extra: Record<string, unknown> = {}) => ({
    ...baseDoc(),
    location: {
      storeyName: null,
      bim: null,
      pdf: { pdfFileId: "f1", page: 1, uv: [0.1, 0.2], calibId: "c1", ...extra },
    },
  });

  it("keeps old pins (no pdfVersionId) valid", () => {
    expect(TaskSchema.safeParse(pdfLoc()).success).toBe(true);
  });
  it("accepts a pdfVersionId and round-trips it", () => {
    const r = TaskSchema.parse(pdfLoc({ pdfVersionId: "v2" }));
    expect(r.location?.pdf?.pdfVersionId).toBe("v2");
  });
  it("rejects a non-string / empty pdfVersionId", () => {
    expect(TaskSchema.safeParse(pdfLoc({ pdfVersionId: 3 })).success).toBe(false);
    expect(TaskSchema.safeParse(pdfLoc({ pdfVersionId: "" })).success).toBe(false);
  });
  it('treats calibId "uncalibrated" as an ordinary valid string (official sentinel)', () => {
    expect(TaskSchema.safeParse(pdfLoc({ calibId: "uncalibrated" })).success).toBe(true);
    expect(TaskSchema.safeParse(pdfLoc({ calibId: "" })).success).toBe(false);
  });
});

describe("TaskSchema.sheetRefs (attach from project; additive)", () => {
  const ref = { pdfFileId: "f1", pdfVersionId: "f1v1", versionNumber: 1, name: "A101.pdf" };
  it("older docs without the field parse unchanged", () => {
    const r = TaskSchema.parse(baseDoc());
    expect(r.sheetRefs).toBeUndefined();
  });
  it("accepts references (file + version, optional page / version number)", () => {
    const r = TaskSchema.parse({ ...baseDoc(), sheetRefs: [ref, { pdfFileId: "f2", pdfVersionId: "v", name: "S", page: 2 }] });
    expect(r.sheetRefs).toHaveLength(2);
  });
  it("rejects an empty file / version id, a bad page and more than 20", () => {
    expect(TaskSchema.safeParse({ ...baseDoc(), sheetRefs: [{ ...ref, pdfFileId: "" }] }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...baseDoc(), sheetRefs: [{ ...ref, pdfVersionId: "" }] }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...baseDoc(), sheetRefs: [{ ...ref, page: 0 }] }).success).toBe(false);
    expect(TaskSchema.safeParse({ ...baseDoc(), sheetRefs: Array.from({ length: 21 }, () => ref) }).success).toBe(false);
  });
});

describe("TaskSchema · location.thumb2d / location.origin (LinkView dual location)", () => {
  const bim = {
    elements: [{ modelId: "m1", expressId: 7 }],
    worldPoint: [1, 2, 3] as [number, number, number],
    cameraPose: { pos: [0, 0, 5] as [number, number, number], target: [1, 2, 3] as [number, number, number], fov: 50, isOrtho: false },
  };
  const pdf = { pdfFileId: "p1", page: 1, uv: [0.25, 0.5] as [number, number], calibId: "p1__L1", pdfVersionId: "p1v1" };

  it("a legacy 3D-only and plan-only location parse unchanged (no thumb2d/origin appear)", () => {
    const a = TaskSchema.parse({ ...baseDoc(), location: { storeyName: "L1", thumb: { storagePath: "a" }, bim, pdf: null } });
    expect(a.location?.thumb2d).toBeUndefined();
    expect(a.location?.origin).toBeUndefined();
    const b = TaskSchema.parse({ ...baseDoc(), location: { storeyName: "L1", bim: null, pdf } });
    expect(b.location?.origin).toBeUndefined();
  });

  it("a LinkView location round-trips both sides, both thumbs and the origin", () => {
    const loc = {
      storeyName: "L1",
      origin: "linkview",
      thumb: { storagePath: "projects/p/tasks/t1/location-thumb.jpg" },
      thumb2d: { storagePath: "projects/p/tasks/t1/location-thumb-2d.jpg" },
      bim,
      pdf,
    };
    const parsed = TaskSchema.parse({ ...baseDoc(), location: loc });
    expect(parsed.location).toMatchObject(loc);
  });

  it("rejects an empty thumb2d path", () => {
    expect(() =>
      TaskSchema.parse({ ...baseDoc(), location: { storeyName: null, thumb2d: { storagePath: "" }, bim: null, pdf: null } }),
    ).toThrow();
  });
});
