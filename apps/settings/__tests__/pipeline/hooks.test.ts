// __tests__/pipeline/hooks.test.ts
//
// Lightweight smoke tests for the reactive Dexie hooks
// (useIfcFiles, useStoreys). They run the *real* hooks under
// @testing-library/react with a shared fake-indexeddb and verify
// the live query re-fires when the underlying tables change.
//
// We don't try to load a real IFC here — that's covered by
// loadIfc.test.ts. The point of this file is to lock the live-
// query contract: subscriptions update, empties are returned for
// null buildingId, etc.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcFiles } from "@ff/data/hooks";
import { useStoreys } from "@hooks/useStoreys";

import { resetDb } from "../db/helpers";
import { createProject } from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { createStorey, createStoreys } from "@ff/data/db/tables/storeys";

async function makeBuilding() {
  const p = await createProject({ name: "HooksTestProject", metadata: {} });
  return createBuilding({ projectId: p.id, name: "HooksTestBuilding", metadata: {} });
}

async function makeFileWithOneStorey(
  buildingId: string,
  name: string,
  storeyElevation: number,
) {
  const f = await createIfcFile({
    buildingId,
    name,
    currentVersionId: "placeholder",
  });
  // Patch the placeholder to a real version id once we have it.
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1024,
    contentHash: "hash-" + name,
    fragBlobKey: `blob-${f.id}`,
    storeyCount: 1,
    isLatest: true,
  });
  await db.ifcFiles.update(f.id, { currentVersionId: v.id });
  const s = await createStorey({
    buildingId,
    ifcVersionId: v.id,
    sourceIfcFileId: f.id,
    name: `Storey at ${storeyElevation}`,
    elevation: storeyElevation,
    expressId: 1,
    height: null,
  });
  return { file: f, version: v, storey: s };
}

describe("useIfcFiles (reactive live query)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("useIfcFiles");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("returns an empty array for a null buildingId", async () => {
    const { result } = renderHook(() => useIfcFiles(null));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it("returns an empty array for a buildingId with no files", async () => {
    const b = await makeBuilding();
    const { result } = renderHook(() => useIfcFiles(b.id));
    await waitFor(() => {
      expect(result.current).toEqual([]);
    });
  });

  it("returns one entry per file, each with the version chain", async () => {
    const b = await makeBuilding();
    const { file } = await makeFileWithOneStorey(b.id, "alpha.ifc", 0);
    const { result } = renderHook(() => useIfcFiles(b.id));
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    const entry = result.current[0];
    expect(entry.file.id).toBe(file.id);
    expect(entry.versionCount).toBe(1);
    expect(entry.versions).toHaveLength(1);
    expect(entry.latestVersion?.versionNumber).toBe(1);
    expect(entry.latestVersionId).toBe(entry.latestVersion?.id);
  });

  it("updates when a new file is added (live query)", async () => {
    const b = await makeBuilding();
    const { result } = renderHook(() => useIfcFiles(b.id));
    await waitFor(() => expect(result.current).toEqual([]));

    await act(async () => {
      await makeFileWithOneStorey(b.id, "live.ifc", 1.5);
    });
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].file.name).toBe("live.ifc");
  });
});

describe("useStoreys (reactive live query)", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });

  beforeEach(async () => {
    await resetDb("useStoreys");
  });

  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("returns [] for null buildingId", async () => {
    const { result } = renderHook(() => useStoreys(null));
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("returns [] when activeIfcVersionIds is [] (caller has picked none)", async () => {
    const b = await makeBuilding();
    const { version } = await makeFileWithOneStorey(b.id, "x.ifc", 0);
    // The storey is in the DB; we just aren't asking for it.
    const { result } = renderHook(() => useStoreys(b.id, []));
    await waitFor(() => expect(result.current).toEqual([]));
    expect(version).toBeDefined();
  });

  it("returns all storeys when activeIfcVersionIds is undefined", async () => {
    const b = await makeBuilding();
    const { storey } = await makeFileWithOneStorey(b.id, "all.ifc", 2.5);
    const { result } = renderHook(() => useStoreys(b.id, undefined));
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].id).toBe(storey.id);
    expect(result.current[0].elevation).toBe(2.5);
  });

  it("filters storeys by activeIfcVersionIds", async () => {
    const b = await makeBuilding();
    // File A: one storey at z=0
    const a = await makeFileWithOneStorey(b.id, "a.ifc", 0);
    // File B: one storey at z=5
    const c = await makeFileWithOneStorey(b.id, "c.ifc", 5);
    const bStoreys = await createStoreys([
      {
        buildingId: b.id,
        ifcVersionId: c.version.id,
        sourceIfcFileId: c.file.id,
        name: "Roof",
        elevation: 5,
        expressId: 2,
        height: null,
      },
    ]);
    void a;
    void bStoreys;
    // Only ask for file A's version → only file A's storey.
    const { result } = renderHook(() =>
      useStoreys(b.id, [a.version.id]),
    );
    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });
    expect(result.current[0].name).toBe("Storey at 0");
  });

  it("sorts storeys by elevation ascending", async () => {
    const b = await makeBuilding();
    // Add storeys out of order
    const { version } = await makeFileWithOneStorey(b.id, "unsorted.ifc", 0);
    await createStoreys([
      {
        buildingId: b.id,
        ifcVersionId: version.id,
        sourceIfcFileId: version.ifcFileId,
        name: "Top",
        elevation: 10,
        expressId: 100,
        height: null,
      },
      {
        buildingId: b.id,
        ifcVersionId: version.id,
        sourceIfcFileId: version.ifcFileId,
        name: "Middle",
        elevation: 5,
        expressId: 101,
        height: null,
      },
      {
        buildingId: b.id,
        ifcVersionId: version.id,
        sourceIfcFileId: version.ifcFileId,
        name: "Bottom",
        elevation: -2,
        expressId: 102,
        height: null,
      },
    ]);
    const { result } = renderHook(() => useStoreys(b.id, undefined));
    await waitFor(() => {
      expect(result.current).toHaveLength(4);
    });
    const names = result.current.map((s) => s.name);
    // We added one at 0 (from makeFileWithOneStorey) + Top, Middle, Bottom.
    // Lowest first.
    expect(names[0]).toBe("Bottom");
    expect(names[1]).toBe("Storey at 0");
    expect(names[2]).toBe("Middle");
    expect(names[3]).toBe("Top");
  });
});
