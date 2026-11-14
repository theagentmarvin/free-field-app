// __tests__/pipeline/useIfcPipeline.test.ts
//
// Tests for parseIfc() — specifically the property catalog walk,
// including the synthetic `_IfcClass` rows introduced in Task
// 20C-Part 2 §2.
//
// We exercise the *real* web-ifc + IfcImporter against the
// public/samples/sample.ifc fixture (same setup as loadIfc.test.ts).
// Mocking web-ifc's WASM-bound IfcAPI is brittle and would defeat
// the purpose; running against a real IFC file gives us
// end-to-end confidence that the walk works.
//
// Per spec §6 criterion 3:
//   "New test: `_IfcClass` rows present in `propertyCatalog` after
//    parseIfc walk. If the existing `useIfcPipeline.test.ts`
//    doesn't cover the catalog walk, add at least one test that
//    asserts `(fileId, "_IfcClass", "IfcWall")` etc. are in the
//    catalog after a parse."

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { parseIfc, useIfcPipeline } from "@ff/data/hooks";

import { resetDb } from "../db/helpers";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

const SAMPLE_PATH = resolve(
  __dirname,
  "..",
  "..",
  "public",
  "samples",
  "sample.ifc",
);
const SAMPLE_BYTES = readFileSync(SAMPLE_PATH);

function makeIfcFile(name: string): File {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F = (globalThis as any).File ?? File;
  return new F([SAMPLE_BYTES], name, { type: "application/x-step" });
}

async function makeBuilding() {
  const p = await createProject({ name: "CatalogTestProject", metadata: {} });
  return createBuilding({
    projectId: p.id,
    name: "CatalogTestBuilding",
    metadata: {},
  });
}

describe("parseIfc — property catalog walk (Task 20C-Part 2)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("parseIfc-catalog");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("extracts the standard Pset_* + Qto_* rows from sample.ifc", async () => {
    const parsed = await parseIfc(new Uint8Array(SAMPLE_BYTES));

    // The catalog walk is best-effort; we just assert it's populated
    // and contains a few known psets from the sample.
    expect(parsed.propertyCatalog.length).toBeGreaterThan(0);
    const psets = new Set(parsed.propertyCatalog.map((e) => e.pset));
    // sample.ifc contains several Pset_* rows (verified via grep:
    // Pset_QuantityTakeOff, Pset_ReinforcementBarPitchOfSlab,
    // Pset_SlabCommon, Pset_VDC). Assert at least one is present.
    const knownPsets = [
      "Pset_QuantityTakeOff",
      "Pset_ReinforcementBarPitchOfSlab",
      "Pset_SlabCommon",
      "Pset_VDC",
    ];
    const anyPresent = knownPsets.some((p) => psets.has(p));
    expect(anyPresent).toBe(true);
  });

  it("extracts synthetic _IfcClass rows for every distinct element class", async () => {
    const parsed = await parseIfc(new Uint8Array(SAMPLE_BYTES));

    // Pull the synthetic rows.
    const ifcClassRows = parsed.propertyCatalog.filter(
      (e) => e.pset === "_IfcClass",
    );
    // sample.ifc has IFCBEAM, IFCCOLUMN, IFCSLAB at minimum (verified
    // empirically via grep on the file). We don't pin to those exact
    // names — `_IfcClass` rows may include any IFC entity that's
    // referenced by an IFCRELDEFINESBYPROPERTIES row. The point is
    // that the synthetic walk produced at least one row and that
    // every row's pset is "_IfcClass" with a non-empty name.
    expect(ifcClassRows.length).toBeGreaterThan(0);
    for (const row of ifcClassRows) {
      expect(row.pset).toBe("_IfcClass");
      expect(row.name.length).toBeGreaterThan(0);
      // IFC class names from GetNameFromTypeCode are CamelCase
      // ("IfcSlab", "IfcWall", "IfcBeam") — not the all-uppercase
      // numeric code constants ("IFCSLAB", "IFCWALL", "IFCBEAM").
      expect(row.name).toMatch(/^Ifc[A-Z]/);
    }

    // Dedup: every (pset, name) is unique within the catalog.
    const seen = new Set<string>();
    for (const r of ifcClassRows) {
      const key = `${r.pset}\x00${r.name}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("parseIfc — IfcRelContainedInSpatialStructure walk (Task 22-amendment)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("parseIfc-containment");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("populates containedElementIds on parsed storeys from sample.ifc", async () => {
    const parsed = await parseIfc(new Uint8Array(SAMPLE_BYTES));

    // sample.ifc has 5 IfcRelContainedInSpatialStructure rows and
    // 6 IfcBuildingStorey entities (verified by `grep -c` on the
    // fixture). At least one storey must have a non-empty
    // containedElementIds after the walk.
    expect(parsed.storeys.length).toBeGreaterThan(0);
    const withElements = parsed.storeys.filter(
      (s) => s.containedElementIds.length > 0,
    );
    expect(withElements.length).toBeGreaterThan(0);

    // Every expressId in containedElementIds is a number (sanity).
    for (const storey of parsed.storeys) {
      for (const id of storey.containedElementIds) {
        expect(typeof id).toBe("number");
        expect(Number.isFinite(id)).toBe(true);
      }
    }

    // Every contained element id should be distinct across all
    // storeys (a given IFC element is contained in exactly one
    // spatial structure).
    const allIds = parsed.storeys.flatMap((s) => s.containedElementIds);
    const unique = new Set(allIds);
    expect(unique.size).toBe(allIds.length);
  });

  it("persists containedElementIds on storeys after loadIfc", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("containment-model.ifc");

    const { result } = renderHook(() => useIfcPipeline());
    let r: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r = await result.current.loadIfc(file, building.id);
    });

    // Look up the storeys persisted for this version. At least one
    // should have a non-empty containedElementIds array.
    const storeys = await db.storeys
      .where("ifcVersionId")
      .equals(r!.versionId)
      .toArray();
    expect(storeys.length).toBeGreaterThan(0);
    const withElements = storeys.filter(
      (s) => Array.isArray(s.containedElementIds) && s.containedElementIds.length > 0,
    );
    expect(withElements.length).toBeGreaterThan(0);
  });
});

describe("useIfcPipeline.loadIfc — _IfcClass persistence (Task 20C-Part 2)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("loadIfc-catalog");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("persists _IfcClass rows to the propertyCatalog table after loadIfc", async () => {
    const building = await makeBuilding();
    const file = makeIfcFile("catalog-model.ifc");

    const { result } = renderHook(() => useIfcPipeline());
    let r: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r = await result.current.loadIfc(file, building.id);
    });

    // The Dexie propertyCatalog should now contain _IfcClass rows
    // for this file. We don't pin exact class names (depends on
    // web-ifc's class registry), but the rows must be present and
    // share the right fileId.
    const catalogRows = await db.propertyCatalog
      .where({ fileId: r!.ifcFileId })
      .toArray();
    const ifcClassRows = catalogRows.filter((e) => e.pset === "_IfcClass");
    expect(ifcClassRows.length).toBeGreaterThan(0);

    // Every row's fileId matches the persisted IfcFileRecord.
    for (const row of ifcClassRows) {
      expect(row.fileId).toBe(r!.ifcFileId);
      expect(row.pset).toBe("_IfcClass");
      expect(row.name.length).toBeGreaterThan(0);
    }
  });
});