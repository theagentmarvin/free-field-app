// __tests__/hooks/useExtractedStoreys.test.tsx
//
// Live-query contract for useExtractedStoreys: null buildingId
// returns []; orphans (extracted row whose storey was deleted) are
// skipped with a console.warn; sort is by elevation ascending; new
// rows propagate via Dexie's live-query.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useExtractedStoreys } from "@hooks/useExtractedStoreys";
import { setExtracted } from "@ff/data/db/tables/extractedStoreys";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { createStorey, createStoreys } from "@ff/data/db/tables/storeys";

import { resetDb } from "../db/helpers";

async function makeContext() {
  const p = await createProject({ name: "HookTest", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  const f = await createIfcFile({
    buildingId: b.id,
    name: "model.ifc",
    currentVersionId: "placeholder",
  });
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 0,
    isLatest: true,
  });
  await db.ifcFiles.update(f.id, { currentVersionId: v.id });
  return { project: p, building: b, file: f, version: v };
}

describe("useExtractedStoreys (reactive live query)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("useExtractedStoreys");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("returns [] when buildingId is null", async () => {
    const { result } = renderHook(() => useExtractedStoreys(null));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it("returns [] when there are no extracted rows", async () => {
    const { building } = await makeContext();
    const { result } = renderHook(() => useExtractedStoreys(building.id));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it("joins extractedStoreys with storeys and sorts by elevation ascending", async () => {
    const { building, file, version } = await makeContext();
    const [s1, s2, s3] = await createStoreys([
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "Mid",
        elevation: 5,
        expressId: 1,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "Low",
        elevation: 1,
        expressId: 2,
        height: null,
      },
      {
        buildingId: building.id,
        ifcVersionId: version.id,
        sourceIfcFileId: file.id,
        name: "High",
        elevation: 10,
        expressId: 3,
        height: null,
      },
    ]);
    await setExtracted(building.id, s1.id, true);
    await setExtracted(building.id, s2.id, true);
    await setExtracted(building.id, s3.id, true);

    const { result } = renderHook(() => useExtractedStoreys(building.id));
    await waitFor(() => {
      expect(result.current).toHaveLength(3);
    });
    expect(result.current.map((m) => m.storey.name)).toEqual([
      "Low",
      "Mid",
      "High",
    ]);
    expect(result.current[0].extractedId).toBeTruthy();
  });

  it("skips orphan rows where the storey was deleted", async () => {
    const { building, file, version } = await makeContext();
    const orphan = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Orphan",
      elevation: 0,
      expressId: 1,
      height: null,
    });
    const survivor = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Survivor",
      elevation: 1,
      expressId: 2,
      height: null,
    });
    await setExtracted(building.id, orphan.id, true);
    await setExtracted(building.id, survivor.id, true);
    // Delete the storey out from under the extracted row.
    await db.storeys.delete(orphan.id);

    // Silence the dev-only console.warn the hook emits for orphans
    // so the test output is clean. We assert the warn fired below.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { result } = renderHook(() => useExtractedStoreys(building.id));
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].storey.name).toBe("Survivor");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("live-updates when a row is added (useLiveQuery re-fires)", async () => {
    const { building, file, version } = await makeContext();
    const s = await createStorey({
      buildingId: building.id,
      ifcVersionId: version.id,
      sourceIfcFileId: file.id,
      name: "Late",
      elevation: 0,
      expressId: 1,
      height: null,
    });

    const { result } = renderHook(() => useExtractedStoreys(building.id));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });

    await act(async () => {
      await setExtracted(building.id, s.id, true);
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].storey.name).toBe("Late");
  });
});
