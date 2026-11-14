// apps/models/__tests__/usePropertyCatalog.test.tsx
//
// Unit tests for the in-memory cache hook from Task 20C-Part 1.
// The hook wraps Dexie's `useLiveQuery` with a `useMemo` grouping
// step, so we exercise both the Dexie side (does the live query
// actually re-fire when the table changes?) and the JS side
// (grouping + sort).
//
// Coverage (per spec §8 criterion 2):
//   (a) empty fileId returns empty cache immediately, no DB hit
//   (b) populated fileId returns the entries + grouped byPset
//   (c) live query updates the cache when a new row is added
//   (d) grouping is case-sensitive and alphabetically sorted
//       within each pset
//
// Dexie + jsdom are wired via apps/models/__tests__/setup.ts.

import { afterEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";

import {
  testDb,
  type TestPropertyCatalogEntry,
} from "./support/testDb";
import { renderHookWithDataSource } from "./support/renderWithDataSource";

import { usePropertyCatalog } from "../src/hooks/usePropertyCatalog";

afterEach(async () => {
  // Clear between tests so live-query state can't leak.
  await testDb.propertyCatalog.clear();
});

function entries(
  fileId: string,
  pairs: Array<[string, string]>,
): TestPropertyCatalogEntry[] {
  return pairs.map(([pset, name]) => ({ fileId, pset, name }));
}

describe("usePropertyCatalog — empty / null fileId", () => {
  it("(a) returns an empty cache when fileId is null", async () => {
    const { result } = renderHookWithDataSource(() => usePropertyCatalog(null));

    // The hook short-circuits in its querier when fileId is null
    // and returns []. Let microtasks flush, then assert.
    await waitFor(() => {
      expect(result.current.count).toBe(0);
    });
    expect(result.current.entries).toEqual([]);
    expect(result.current.byPset.size).toBe(0);
    // Loading is false because the resolved value (from the
    // short-circuited querier) is the empty array, which is also
    // our defaultResult — both are `[]`. The hook still reports
    // loading=false, which is fine for the empty case.
    expect(result.current.loading).toBe(false);
  });
});

describe("usePropertyCatalog — populated fileId", () => {
  it("(b) returns the entries + grouped byPset for a known file", async () => {
    const fileId = "file-A";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_WallCommon", "FireRating"],
        ["Pset_WallCommon", "IsExternal"],
        ["Pset_WallCommon", "ThermalTransmittance"],
        ["Pset_DoorCommon", "FireRating"],
        ["Pset_DoorCommon", "GlazingArea"],
        ["Qto_WallBaseQuantities", "GrossVolume"],
        ["Qto_WallBaseQuantities", "NetVolume"],
      ]),
    );

    const { result } = renderHookWithDataSource(() => usePropertyCatalog(fileId));

    // Wait for the live query to resolve with our 7 rows. We can't
    // gate on `loading` here because useLiveQuery's defaultResult
    // (empty array) makes `loading` false from the initial render;
    // the actual signal is `count === expectedCount`.
    await waitFor(() => {
      expect(result.current.count).toBe(7);
    });

    expect(result.current.entries).toHaveLength(7);
    expect(result.current.entries).toHaveLength(7);
    // Verify byPset shape: 3 psets, each with its property list
    expect(result.current.byPset.size).toBe(3);
    expect(result.current.byPset.get("Pset_WallCommon")).toEqual([
      "FireRating",
      "IsExternal",
      "ThermalTransmittance",
    ]);
    expect(result.current.byPset.get("Pset_DoorCommon")).toEqual([
      "FireRating",
      "GlazingArea",
    ]);
    expect(result.current.byPset.get("Qto_WallBaseQuantities")).toEqual([
      "GrossVolume",
      "NetVolume",
    ]);
  });

  it("(b2) does not leak rows from other files", async () => {
    const target = "file-target";
    const other = "file-other";
    await testDb.propertyCatalog.bulkAdd([
      ...entries(target, [["Pset_A", "X"]]),
      ...entries(other, [["Pset_B", "Y"], ["Pset_C", "Z"]]),
    ]);

    const { result } = renderHookWithDataSource(() => usePropertyCatalog(target));

    await waitFor(() => {
      expect(result.current.count).toBe(1);
    });

    // The hook returns the "lite" shape (pset + name only) — the
    // DI boundary strips fileId. Non-leakage is asserted via the
    // count (only the target file's single row) + the absence of
    // the other file's psets below.
    expect(result.current.count).toBe(1);
    expect(result.current.byPset.has("Pset_B")).toBe(false);
    expect(result.current.byPset.has("Pset_C")).toBe(false);
  });
});

describe("usePropertyCatalog — live query reactivity", () => {
  it("(c) re-fires when a new row is added to the table", async () => {
    const fileId = "file-live";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [["Pset_Start", "Initial"]]),
    );

    const { result } = renderHookWithDataSource(() => usePropertyCatalog(fileId));

    await waitFor(() => {
      expect(result.current.count).toBe(1);
    });

    // Add a new row AFTER the hook has resolved; useLiveQuery should
    // detect the change and re-fire the result.
    await act(async () => {
      await testDb.propertyCatalog.add({
        fileId,
        pset: "Pset_LiveAdded",
        name: "AddedLater",
      });
    });

    await waitFor(() => {
      expect(result.current.count).toBe(2);
    });
    expect(result.current.byPset.get("Pset_LiveAdded")).toEqual([
      "AddedLater",
    ]);
    // Existing grouping should still be intact
    expect(result.current.byPset.get("Pset_Start")).toEqual(["Initial"]);
  });
});

describe("usePropertyCatalog — grouping semantics", () => {
  it("(d) sorts property names alphabetically within each pset (case-sensitive)", async () => {
    const fileId = "file-sort";
    // Deliberately unsorted, mixed-case input to verify both axes.
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_X", "zulu"],
        ["Pset_X", "alpha"],
        ["Pset_X", "Mike"],
        ["Pset_X", "bravo"],
        ["Pset_X", "Alpha"], // uppercase A — should come AFTER lowercase 'a' in default JS sort (aA)
        ["Pset_X", "mike"],
        ["Pset_Y", "delta"],
        ["Pset_Y", "charlie"],
      ]),
    );

    const { result } = renderHookWithDataSource(() => usePropertyCatalog(fileId));

    await waitFor(() => {
      expect(result.current.count).toBe(8);
    });

    const xList = result.current.byPset.get("Pset_X");
    expect(xList).toBeDefined();
    // JS default sort: uppercase letters sort BEFORE lowercase in
    // ASCII (e.g. "Alpha" < "Mike" < "alpha" < "bravo" < "mike" <
    // "zulu"). This is exactly what the spec calls "case-sensitive
    // sorting" — we don't lowercase before compare, we preserve the
    // raw byte order. Verify the actual sorted order:
    expect(xList).toEqual([
      "Alpha",
      "Mike",
      "alpha",
      "bravo",
      "mike",
      "zulu",
    ]);
    expect(result.current.byPset.get("Pset_Y")).toEqual([
      "charlie",
      "delta",
    ]);
  });

  it("(d2) pset keys preserve case exactly as stored", async () => {
    const fileId = "file-keys";
    await testDb.propertyCatalog.bulkAdd(
      entries(fileId, [
        ["Pset_WallCommon", "X"],
        ["pset_wallcommon", "X"], // different case pset, same name
        ["PSET_DOORCOMMON", "Y"],
      ]),
    );

    const { result } = renderHookWithDataSource(() => usePropertyCatalog(fileId));

    await waitFor(() => {
      expect(result.current.count).toBe(3);
    });

    expect(result.current.byPset.size).toBe(3);
    expect(result.current.byPset.has("Pset_WallCommon")).toBe(true);
    expect(result.current.byPset.has("pset_wallcommon")).toBe(true);
    expect(result.current.byPset.has("PSET_DOORCOMMON")).toBe(true);
  });
});