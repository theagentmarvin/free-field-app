// __tests__/pipeline/ifcImportSinglePass.test.ts
//
// Wave 61: loadIfc / replaceIfcVersion parse the IFC ONCE (was three
// times: parseIfc + IfcImporter geometry + IfcImporter properties)
// and clear `progress` when idle (progress messages themselves are
// covered by packages/ff-data/__tests__/ifc). Under vitest there is no Worker, so
// runIfcImport takes its in-thread fallback — the same job runner the
// worker executes.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as WEBIFC from "web-ifc";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcPipeline, parseIfc } from "@ff/data/hooks";
import { listStoreysByVersion } from "@ff/data/db/tables/storeys";

import { resetDb } from "../db/helpers";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";

const SAMPLE_BYTES = readFileSync(
  resolve(__dirname, "..", "..", "public", "samples", "sample.ifc"),
);

function makeIfcFile(name: string): File {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const F = (globalThis as any).File ?? File;
  return new F([SAMPLE_BYTES], name, { type: "application/x-step" });
}

async function makeBuilding() {
  const p = await createProject({ name: "SinglePassProject", metadata: {} });
  return createBuilding({ projectId: p.id, name: "SinglePassBuilding", metadata: {} });
}

describe("IFC import — single web-ifc parse + progress (wave 61)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  beforeEach(async () => {
    await resetDb("ifc-single-pass");
  });
  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("loadIfc opens the IFC once and persists the same storeys/catalog as parseIfc", async () => {
    const building = await makeBuilding();
    const reference = await parseIfc(new Uint8Array(SAMPLE_BYTES));

    const { result } = renderHook(() => useIfcPipeline());
    expect(result.current.progress).toBeNull();

    const opens = vi.spyOn(WEBIFC.IfcAPI.prototype, "OpenModel");
    let r: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      r = await result.current.loadIfc(makeIfcFile("single.ifc"), building.id);
    });
    const openCalls = opens.mock.calls.length;
    opens.mockRestore();

    expect(openCalls).toBe(1);
    expect(result.current.progress).toBeNull(); // cleared when idle

    const storeys = await listStoreysByVersion(r!.versionId);
    expect(storeys.map((s) => [s.name, s.elevation, s.expressId, s.containedElementIds]))
      .toEqual(
        expect.arrayContaining(
          reference.storeys.map((s) => [s.name, s.elevation, s.expressId, s.containedElementIds]),
        ),
      );
    expect(storeys).toHaveLength(reference.storeys.length);
    expect(r!.storeyCount).toBe(reference.storeys.length);

    const catalog = await db.propertyCatalog.where("fileId").equals(r!.ifcFileId).toArray();
    expect(catalog).toHaveLength(reference.propertyCatalog.length);
  });

  it("replaceIfcVersion also parses once", async () => {
    const building = await makeBuilding();
    const { result } = renderHook(() => useIfcPipeline());
    let first: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      first = await result.current.loadIfc(makeIfcFile("rep.ifc"), building.id);
    });
    const opens = vi.spyOn(WEBIFC.IfcAPI.prototype, "OpenModel");
    let second: Awaited<ReturnType<typeof result.current.replaceIfcVersion>>;
    await act(async () => {
      second = await result.current.replaceIfcVersion(first!.ifcFileId, makeIfcFile("rep.ifc"));
    });
    const openCalls = opens.mock.calls.length;
    opens.mockRestore();
    expect(openCalls).toBe(1);
    expect(second!.versionNumber).toBe(2);
    expect(second!.storeyCount).toBe(first!.storeyCount);
  });
});
