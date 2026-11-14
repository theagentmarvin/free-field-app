// __tests__/hooks/useCalibrations.test.ts
//
// Live-query contract for useCalibrationsForProject:
//   - null projectId → empty result
//   - empty project → empty result
//   - calibrations are bucketed by pdfFileId and storeyName
//   - live updates propagate via Dexie

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useCalibrationsForProject } from "@hooks/useCalibrations";
import { createCalibration, deleteCalibration } from "@ff/data/db/tables/calibrations";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createPdfFile } from "@ff/data/db/tables/pdfFiles";

import { resetDb } from "../db/helpers";

async function makeContext() {
  const p = await createProject({ name: "HookTest", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  return { project: p, building: b };
}

async function makeCalibration(
  pdfFileId: string,
  storeyName: string,
  projectId = "default-project",
) {
  return createCalibration({
    projectId,
    pdfFileId,
    storeyName,
    pointPairs: [
      { pdfX: 0, pdfY: 0, worldX: 0, worldZ: 0 },
      { pdfX: 1, pdfY: 1, worldX: 2, worldZ: 2 },
    ] as never,
    transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 },
    confidence: 1,
  });
}

describe("useCalibrationsForProject (reactive live query)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("useCalibrations");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("returns the empty result for null projectId", async () => {
    const { result } = renderHook(() =>
      useCalibrationsForProject(null),
    );
    await waitFor(() => {
      expect(result.current.calibrations).toEqual([]);
    });
    expect(result.current.byPdfFileId.size).toBe(0);
    expect(result.current.byStoreyName.size).toBe(0);
  });

  it("returns the empty result for a project with no calibrations", async () => {
    await makeContext();
    const { result } = renderHook(() =>
      useCalibrationsForProject("default-project"),
    );
    await waitFor(() => {
      // isLoading flips false after the first query.
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.calibrations).toEqual([]);
    expect(result.current.byPdfFileId.size).toBe(0);
  });

  it("buckets calibrations by pdfFileId and storeyName", async () => {
    await makeContext();
    const b = await db.buildings.toArray();
    const building = b[0]!;
    const f1 = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    const f2 = await createPdfFile({ buildingId: building.id, name: "b.pdf" });
    await makeCalibration(f1.id, "L1");
    await makeCalibration(f1.id, "L2");
    await makeCalibration(f2.id, "L1");

    const { result } = renderHook(() =>
      useCalibrationsForProject("default-project"),
    );
    await waitFor(() => {
      expect(result.current.calibrations).toHaveLength(3);
    });
    expect(result.current.byPdfFileId.get(f1.id)?.length).toBe(2);
    expect(result.current.byPdfFileId.get(f2.id)?.length).toBe(1);
    expect(result.current.byStoreyName.get("L1")?.length).toBe(2);
    expect(result.current.byStoreyName.get("L2")?.length).toBe(1);
  });

  it("propagates inserts via Dexie's live query", async () => {
    await makeContext();
    const b = await db.buildings.toArray();
    const building = b[0]!;
    const f = await createPdfFile({ buildingId: building.id, name: "a.pdf" });

    const { result } = renderHook(() =>
      useCalibrationsForProject("default-project"),
    );
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.calibrations).toHaveLength(0);

    await act(async () => {
      await makeCalibration(f.id, "L1");
    });
    await waitFor(() => {
      expect(result.current.calibrations).toHaveLength(1);
    });
    expect(result.current.byPdfFileId.get(f.id)?.length).toBe(1);
  });

  it("propagates deletes via Dexie's live query", async () => {
    await makeContext();
    const b = await db.buildings.toArray();
    const building = b[0]!;
    const f = await createPdfFile({ buildingId: building.id, name: "a.pdf" });
    const c = await makeCalibration(f.id, "L1");

    const { result } = renderHook(() =>
      useCalibrationsForProject("default-project"),
    );
    await waitFor(() => {
      expect(result.current.calibrations).toHaveLength(1);
    });

    await act(async () => {
      await deleteCalibration(c.id);
    });
    await waitFor(() => {
      expect(result.current.calibrations).toHaveLength(0);
    });
    expect(result.current.byPdfFileId.get(f.id)).toBeUndefined();
  });
});
