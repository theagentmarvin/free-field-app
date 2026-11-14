// __tests__/hooks/useFilterPresetsForBuilding.test.ts
//
// Task 20D — covers the live query + save/remove surface of the
// per-building filter-preset hook. Mirrors the test discipline in
// __tests__/db/filterPresets.test.ts: pure logic, no React.

import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testDb, clearTestDb } from "../support/testDb";
import { renderHookWithDataSource } from "../support/renderWithDataSource";

import { useFilterPresetsForBuilding } from "../../src/hooks/useFilterPresetsForBuilding";

beforeEach(async () => {
  await clearTestDb();
});

afterEach(async () => {
  await testDb.filterPresets.clear();
});

// Building/project records aren't needed by the injected data source
// (it keys presets by buildingId string), so we use a plain id
// factory instead of the app's createBuilding/createProject helpers.
let buildingSeq = 0;
async function makeBuilding(name = "B") {
  buildingSeq += 1;
  return { id: `building-${buildingSeq}`, name };
}

function makePreset(overrides: Partial<{
  id: string;
  buildingId: string;
  name: string;
  combinator: "AND" | "OR";
  rules: Array<{ property: string; operator: string; value: string }>;
  createdAt: number;
  updatedAt: number;
}> = {}) {
  return {
    id: overrides.id ?? "preset-default",
    buildingId: overrides.buildingId ?? "b1",
    name: overrides.name ?? "Default",
    combinator: overrides.combinator ?? ("AND" as const),
    groups: [
      {
        id: "g1",
        combinator: "AND" as const,
        rules: (overrides.rules ?? []).map((r, i) => ({
          id: `r${i}`,
          property: r.property,
          operator: r.operator,
          value: r.value,
        })),
      },
    ],
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
  };
}

describe("useFilterPresetsForBuilding", () => {
  it("returns an empty list when buildingId is null", async () => {
    const { result } = renderHookWithDataSource(() =>
      useFilterPresetsForBuilding(null),
    );
    // First render returns empty defaults synchronously.
    expect(result.current.presets).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("returns Dexie rows scoped to the active building", async () => {
    const b1 = await makeBuilding("B1");
    const b2 = await makeBuilding("B2");
    await testDb.filterPresets.bulkAdd([
      makePreset({
        id: "p1",
        buildingId: b1.id,
        name: "B1 A",
        updatedAt: 100,
      }),
      makePreset({
        id: "p2",
        buildingId: b1.id,
        name: "B1 B",
        updatedAt: 200,
      }),
      makePreset({
        id: "p3",
        buildingId: b2.id,
        name: "B2 A",
        updatedAt: 300,
      }),
    ]);

    // Sanity: data is visible to a direct query.
    const directRows = await testDb.filterPresets
      .where("buildingId")
      .equals(b1.id)
      .toArray();
    expect(directRows.map((p) => p.name).sort()).toEqual(["B1 A", "B1 B"]);

    const { result } = renderHookWithDataSource(() =>
      useFilterPresetsForBuilding(b1.id),
    );

    await waitFor(() => {
      expect(result.current.presets).toHaveLength(2);
    });
    expect(result.current.presets.map((p) => p.name)).toEqual([
      "B1 B",
      "B1 A",
    ]);
  });

  it("save() upserts a preset (insert + update)", async () => {
    const b = await makeBuilding("B1");
    const { result } = renderHookWithDataSource(() =>
      useFilterPresetsForBuilding(b.id),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Insert.
    await act(async () => {
      await result.current.save(
        makePreset({
          id: "preset-save",
          buildingId: b.id,
          name: "Original",
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.presets.map((p) => p.name)).toEqual([
        "Original",
      ]);
    });

    // Update (same id, different name).
    await act(async () => {
      await result.current.save(
        makePreset({
          id: "preset-save",
          buildingId: b.id,
          name: "Renamed",
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.presets.map((p) => p.name)).toEqual([
        "Renamed",
      ]);
    });

    // Confirm Dexie state matches.
    const row = await testDb.filterPresets.get("preset-save");
    expect(row?.name).toBe("Renamed");
  });

  it("remove() deletes a preset", async () => {
    const b = await makeBuilding("B1");
    await testDb.filterPresets.add(
      makePreset({
        id: "preset-remove",
        buildingId: b.id,
        name: "X",
      }),
    );

    const { result } = renderHookWithDataSource(() =>
      useFilterPresetsForBuilding(b.id),
    );

    await waitFor(() => {
      expect(result.current.presets).toHaveLength(1);
    });

    await act(async () => {
      await result.current.remove("preset-remove");
    });

    await waitFor(() => {
      expect(result.current.presets).toEqual([]);
    });
    expect(await testDb.filterPresets.get("preset-remove")).toBeUndefined();
  });

  it("switching buildingId re-subscribes and filters accordingly", async () => {
    const b1 = await makeBuilding("B1");
    const b2 = await makeBuilding("B2");
    await testDb.filterPresets.bulkAdd([
      makePreset({
        id: "p1",
        buildingId: b1.id,
        name: "B1 A",
      }),
      makePreset({
        id: "p2",
        buildingId: b2.id,
        name: "B2 A",
      }),
    ]);

    const { result, rerender } = renderHookWithDataSource(
      ({ id }: { id: string }) => useFilterPresetsForBuilding(id),
      { initialProps: { id: b1.id } },
    );

    await waitFor(() => {
      expect(result.current.presets.map((p) => p.name)).toEqual(["B1 A"]);
    });

    rerender({ id: b2.id });
    await waitFor(() => {
      expect(result.current.presets.map((p) => p.name)).toEqual(["B2 A"]);
    });
  });
});
