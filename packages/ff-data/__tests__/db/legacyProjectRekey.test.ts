// __tests__/db/legacyProjectRekey.test.ts
//
// Wave 65 — the one-time move of pre-Phase-1 local rows from
// LEGACY_DEFAULT_PROJECT_ID to the user's first real project:
//   - every projectId table (+ the project row, + outbox payloads) moves
//     in one transaction; rows of other projects are untouched;
//   - idempotent (marker per uid + project, and a re-run without the
//     marker moves nothing);
//   - the first project chosen gets the data, a later one gets nothing;
//   - demo mode / the legacy id as target are skipped;
//   - a building-name clash in the target gets a suffix, not an abort.

import { beforeEach, describe, expect, it } from "vitest";
import type { CalibrationRecord, OutboxRecord } from "@ff/types";

import { db } from "../../src/db/database";
import {
  LEGACY_DEFAULT_PROJECT_ID,
  legacyRekeyMarkerKey,
  rekeyLegacyProjectData,
  type RekeyMarkerStorage,
} from "../../src";
import { resetDb } from "../helpers/db";

const LEGACY = LEGACY_DEFAULT_PROJECT_ID;

function memoryStorage(): RekeyMarkerStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function calibration(id: string, projectId: string): CalibrationRecord {
  return {
    id,
    projectId,
    pdfFileId: `pdf-${id}`,
    storeyName: "L1",
    pointPairs: [
      { pdf: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { pdf: { x: 1, y: 1 }, world: { x: 1, y: 1 } },
    ] as unknown as CalibrationRecord["pointPairs"],
    transformParams: {} as CalibrationRecord["transformParams"],
    confidence: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function outbox(id: string, projectId: string): OutboxRecord {
  return {
    id,
    kind: "task-action",
    state: "added",
    projectId,
    payload: { projectId, clientGuid: id },
    photoRefs: [],
    attempts: 0,
    clientGuid: id,
    createdAt: 1,
  };
}

async function seedLegacy(): Promise<void> {
  const meta = { metadata: {}, createdAt: 1, updatedAt: 1 };
  await db.projects.add({ id: LEGACY, name: "Default", ...meta });
  await db.buildings.bulkAdd([
    { id: "b1", projectId: LEGACY, name: "Tower", ...meta },
    { id: "b2", projectId: LEGACY, name: "Annex", ...meta },
    { id: "b-other", projectId: "p-other", name: "Tower", ...meta },
  ]);
  await db.calibrations.bulkAdd([calibration("c1", LEGACY), calibration("c-other", "p-other")]);
  await db.pdfFolders.add({
    id: "f1",
    projectId: LEGACY,
    parentId: null,
    name: "Plans",
    color: "blue",
    createdAt: 1,
    updatedAt: 1,
  });
  await db.viewerViewpoints.add({ id: "v1", projectId: LEGACY, name: "View", createdAt: 1, blob: "{}" });
  await db.outbox.add(outbox("o1", LEGACY));
  await db.drafts.add({ id: "d1", projectId: LEGACY, updatedAt: 1, draft: {} });
}

async function legacyRowCount(): Promise<number> {
  const counts = await Promise.all([
    db.buildings.where("projectId").equals(LEGACY).count(),
    db.calibrations.where("projectId").equals(LEGACY).count(),
    db.pdfFolders.where("projectId").equals(LEGACY).count(),
    db.viewerViewpoints.where("projectId").equals(LEGACY).count(),
    db.outbox.where("projectId").equals(LEGACY).count(),
    db.drafts.where("projectId").equals(LEGACY).count(),
    db.projects.where("id").equals(LEGACY).count(),
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

beforeEach(async () => {
  await resetDb();
});

describe("rekeyLegacyProjectData", () => {
  it("moves every legacy row to the real project, once, and leaves other projects alone", async () => {
    await seedLegacy();
    const storage = memoryStorage();

    const result = await rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage });

    expect(result.status).toBe("rekeyed");
    expect(result.moved).toEqual({
      projects: 1,
      buildings: 2,
      calibrations: 1,
      pdfFolders: 1,
      viewerViewpoints: 1,
      outbox: 1,
      drafts: 1,
    });
    expect(await legacyRowCount()).toBe(0);
    expect((await db.projects.get("p1"))?.name).toBe("Default");
    expect((await db.buildings.get("b1"))?.projectId).toBe("p1");
    expect((await db.buildings.get("b-other"))?.projectId).toBe("p-other");
    expect((await db.calibrations.get("c-other"))?.projectId).toBe("p-other");
    const o1 = await db.outbox.get("o1");
    expect(o1?.projectId).toBe("p1");
    expect(o1?.payload.projectId).toBe("p1");
    expect(storage.map.has(legacyRekeyMarkerKey("u1", "p1"))).toBe(true);
  });

  it("is idempotent: the marker stops a second run, and a run without it moves nothing", async () => {
    await seedLegacy();
    const storage = memoryStorage();
    await rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage });

    // Legacy rows written AFTER the run are not swept up while the marker stands.
    await db.drafts.add({ id: "d-late", projectId: LEGACY, updatedAt: 2, draft: {} });
    const again = await rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage });
    expect(again.status).toBe("already-done");
    expect((await db.drafts.get("d-late"))?.projectId).toBe(LEGACY);

    // Marker lost (e.g. storage cleared) on a DB with nothing legacy left.
    await db.drafts.delete("d-late");
    const fresh = await rekeyLegacyProjectData({
      uid: "u1",
      projectId: "p1",
      isDemo: false,
      storage: memoryStorage(),
    });
    expect(fresh.status).toBe("nothing-to-move");
    expect(await db.buildings.where("projectId").equals("p1").count()).toBe(2);
  });

  it("concurrent calls share one run", async () => {
    await seedLegacy();
    const storage = memoryStorage();
    const [a, b] = await Promise.all([
      rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage }),
      rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage }),
    ]);
    expect(a).toBe(b);
    expect(a.moved.buildings).toBe(2);
  });

  it("only the first project chosen after the upgrade gets the data", async () => {
    await seedLegacy();
    const storage = memoryStorage();
    await rekeyLegacyProjectData({ uid: "u1", projectId: "p1", isDemo: false, storage });
    const second = await rekeyLegacyProjectData({ uid: "u1", projectId: "p2", isDemo: false, storage });
    expect(second.status).toBe("nothing-to-move");
    expect(await db.buildings.where("projectId").equals("p2").count()).toBe(0);
    expect(await db.buildings.where("projectId").equals("p1").count()).toBe(2);
  });

  it("is skipped in demo mode and for the legacy id itself", async () => {
    await seedLegacy();
    const storage = memoryStorage();
    const demo = await rekeyLegacyProjectData({ uid: "demo-admin", projectId: "p1", isDemo: true, storage });
    expect(demo.status).toBe("skipped-demo");
    const self = await rekeyLegacyProjectData({ uid: "u1", projectId: LEGACY, isDemo: false, storage });
    expect(self.status).toBe("skipped-invalid");
    expect(await db.buildings.where("projectId").equals(LEGACY).count()).toBe(2);
    expect(storage.map.size).toBe(0);
  });

  it("renames a building whose name already exists in the target project", async () => {
    await seedLegacy();
    const meta = { metadata: {}, createdAt: 1, updatedAt: 1 };
    await db.projects.add({ id: "p1", name: "Real", ...meta });
    await db.buildings.add({ id: "b-p1", projectId: "p1", name: "Tower", ...meta });

    const result = await rekeyLegacyProjectData({
      uid: "u1",
      projectId: "p1",
      isDemo: false,
      storage: memoryStorage(),
    });

    expect(result.status).toBe("rekeyed");
    expect((await db.buildings.get("b1"))?.name).toBe("Tower (local)");
    expect((await db.buildings.get("b2"))?.name).toBe("Annex");
    // The existing target project row wins; the legacy row is gone.
    expect((await db.projects.get("p1"))?.name).toBe("Real");
    expect(await db.projects.get(LEGACY)).toBeUndefined();
  });
});
