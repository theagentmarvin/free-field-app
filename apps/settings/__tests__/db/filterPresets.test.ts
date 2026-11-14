// __tests__/db/filterPresets.test.ts
//
// Mirrors __tests__/db/pdfFiles.test.ts. Tests CRUD + the
// `[buildingId+updatedAt]` compound index used by the live query
// in apps/models/src/hooks/useFilterPresetsForBuilding.ts.

import { beforeEach, describe, expect, it } from "vitest";

import {
  createFilterPreset,
  getFilterPreset,
  listFilterPresetsByBuilding,
  updateFilterPreset,
  upsertFilterPreset,
  deleteFilterPreset,
  deleteFilterPresetsForBuilding,
} from "@ff/data/db/tables/filterPresets";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { resetDb } from "./helpers";

async function makeBuilding(name = "B") {
  const p = await createProject({ name: "P", metadata: {} });
  return createBuilding({ projectId: p.id, name, metadata: {} });
}

function makeGroups() {
  return [
    {
      id: "g1",
      combinator: "AND" as const,
      rules: [
        {
          id: "r1",
          property: "Pset_WallCommon.FireRating",
          operator: "equals",
          value: "60",
        },
      ],
    },
  ];
}

describe("filterPresets table", () => {
  beforeEach(async () => {
    await resetDb("filterPresets");
  });

  it("creates a filter preset row", async () => {
    const b = await makeBuilding();
    const created = await createFilterPreset({
      id: "preset-a",
      buildingId: b.id,
      name: "Fire-rated walls",
      combinator: "AND",
      groups: makeGroups(),
    });
    expect(created.id).toBe("preset-a");
    expect(created.buildingId).toBe(b.id);
    expect(created.name).toBe("Fire-rated walls");
    expect(created.combinator).toBe("AND");
    expect(created.groups).toHaveLength(1);
    expect(created.createdAt).toBeGreaterThan(0);
  });

  it("reads a filter preset by id", async () => {
    const b = await makeBuilding();
    await createFilterPreset({
      id: "preset-read",
      buildingId: b.id,
      name: "X",
      combinator: "AND",
      groups: makeGroups(),
    });
    const got = await getFilterPreset("preset-read");
    expect(got?.name).toBe("X");
  });

  it("lists presets scoped to a building (most-recent first)", async () => {
    const b1 = await makeBuilding("B1");
    const b2 = await makeBuilding("B2");
    await createFilterPreset({
      id: "p1",
      buildingId: b1.id,
      name: "older",
      combinator: "AND",
      groups: makeGroups(),
      createdAt: 100,
      updatedAt: 100,
    });
    await createFilterPreset({
      id: "p2",
      buildingId: b1.id,
      name: "newer",
      combinator: "AND",
      groups: makeGroups(),
      createdAt: 200,
      updatedAt: 200,
    });
    await createFilterPreset({
      id: "p3",
      buildingId: b2.id,
      name: "other-building",
      combinator: "AND",
      groups: makeGroups(),
    });

    const list = await listFilterPresetsByBuilding(b1.id);
    expect(list.map((p) => p.name)).toEqual(["newer", "older"]);
  });

  it("upsert inserts when missing, updates when present", async () => {
    const b = await makeBuilding();
    const first = await upsertFilterPreset({
      id: "preset-upsert",
      buildingId: b.id,
      name: "Original",
      combinator: "AND",
      groups: makeGroups(),
    });
    expect(first.name).toBe("Original");
    const updated = await upsertFilterPreset({
      id: "preset-upsert",
      buildingId: b.id,
      name: "Renamed",
      combinator: "OR",
      groups: makeGroups(),
    });
    expect(updated.id).toBe("preset-upsert");
    expect(updated.name).toBe("Renamed");
    expect(updated.combinator).toBe("OR");
    expect(updated.createdAt).toBe(first.createdAt); // preserved
    expect(updated.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
  });

  it("updateFilterPreset stamps updatedAt and patches fields", async () => {
    const b = await makeBuilding();
    await createFilterPreset({
      id: "preset-update",
      buildingId: b.id,
      name: "A",
      combinator: "AND",
      groups: makeGroups(),
    });
    const before = await getFilterPreset("preset-update");
    await new Promise((r) => setTimeout(r, 2));
    await updateFilterPreset("preset-update", { name: "B" });
    const after = await getFilterPreset("preset-update");
    expect(after?.name).toBe("B");
    expect(after?.updatedAt).toBeGreaterThan(before!.updatedAt);
  });

  it("deleteFilterPreset removes a single row", async () => {
    const b = await makeBuilding();
    await createFilterPreset({
      id: "preset-del",
      buildingId: b.id,
      name: "X",
      combinator: "AND",
      groups: makeGroups(),
    });
    await deleteFilterPreset("preset-del");
    expect(await getFilterPreset("preset-del")).toBeUndefined();
  });

  it("deleteFilterPresetsForBuilding removes every row for a building", async () => {
    const b1 = await makeBuilding("B1");
    const b2 = await makeBuilding("B2");
    await createFilterPreset({
      id: "p1",
      buildingId: b1.id,
      name: "A",
      combinator: "AND",
      groups: makeGroups(),
    });
    await createFilterPreset({
      id: "p2",
      buildingId: b1.id,
      name: "B",
      combinator: "AND",
      groups: makeGroups(),
    });
    await createFilterPreset({
      id: "p3",
      buildingId: b2.id,
      name: "C",
      combinator: "AND",
      groups: makeGroups(),
    });
    await deleteFilterPresetsForBuilding(b1.id);
    expect(await listFilterPresetsByBuilding(b1.id)).toEqual([]);
    expect((await listFilterPresetsByBuilding(b2.id)).map((p) => p.name)).toEqual([
      "C",
    ]);
  });

  it("schema bump: filterPresets table is reachable on the existing singleton", async () => {
    const b = await makeBuilding();
    // Direct put via the Dexie table reference — exercises the v6
    // schema wire-up without going through the CRUD helper. If the
    // v6 schema was missing this would throw "Table 'filterPresets'
    // not found in schema".
    const { db } = await import("@ff/data/db/database");
    await db.filterPresets.put({
      id: "preset-direct",
      buildingId: b.id,
      name: "Direct",
      combinator: "AND",
      groups: makeGroups(),
      createdAt: 1,
      updatedAt: 1,
    });
    const got = await db.filterPresets.get("preset-direct");
    expect(got?.buildingId).toBe(b.id);
  });
});
