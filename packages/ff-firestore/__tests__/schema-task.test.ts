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
