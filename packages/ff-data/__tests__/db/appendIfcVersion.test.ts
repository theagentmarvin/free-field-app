// __tests__/db/appendIfcVersion.test.ts
//
// The one-transaction IFC write path (wave 63 review items 1, 2, 6):
//   - all records land together, "latest" flipped last;
//   - a failure in ANY step leaves the database untouched (no version
//     marked latest without its storeys / catalog / blob);
//   - re-upload replaces the previous version's storeys and catalog;
//   - duplicate storey names never hit the unique index;
//   - concurrent appends to one file get distinct version numbers;
//   - a full disk surfaces as StorageQuotaExceededError.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../src/db/database";
import {
  appendIfcVersion,
  IfcFileNotFoundError,
  type AppendIfcVersionInput,
} from "../../src/db/appendIfcVersion";
import { isQuotaExceededError, StorageQuotaExceededError } from "../../src/db/errors";
import { resetDb } from "../helpers/db";

function input(over: Partial<AppendIfcVersionInput> = {}): AppendIfcVersionInput {
  return {
    buildingId: "b1",
    fileName: "model.ifc",
    ifcFileSize: 10,
    contentHash: "h1",
    fragBlob: new Blob([new Uint8Array([1, 2, 3])]),
    storeys: [
      { name: "L0", elevation: 0, expressId: 1, height: null, containedElementIds: [10] },
      { name: "L1", elevation: 3, expressId: 2, height: null },
    ],
    propertyCatalog: [
      { pset: "Pset_A", name: "x" },
      { pset: "Pset_A", name: "y" },
    ],
    ...over,
  };
}

async function snapshot() {
  return {
    files: await db.ifcFiles.toArray(),
    versions: await db.ifcVersions.toArray(),
    storeys: await db.storeys.toArray(),
    catalog: await db.propertyCatalog.toArray(),
    blobs: await db.fragBlobs.toCollection().primaryKeys(),
  };
}

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("appendIfcVersion", () => {
  it("creates file + v1 (latest) + blob + storeys + catalog together", async () => {
    const r = await appendIfcVersion(input());
    expect(r.isNewFile).toBe(true);
    expect(r.version.versionNumber).toBe(1);
    expect(r.version.isLatest).toBe(true);
    const s = await snapshot();
    expect(s.files).toHaveLength(1);
    expect(s.files[0].currentVersionId).toBe(r.version.id);
    expect(s.versions).toEqual([expect.objectContaining({ id: r.version.id, isLatest: true, fragBlobKey: `${r.file.id}__v1` })]);
    expect(s.blobs).toEqual([`${r.file.id}__v1`]);
    expect(s.storeys.map((x) => x.name).sort()).toEqual(["L0", "L1"]);
    expect(s.storeys.every((x) => x.ifcVersionId === r.version.id && x.sourceIfcFileId === r.file.id)).toBe(true);
    expect(s.catalog.map((c) => [c.fileId, c.pset, c.name])).toEqual([
      [r.file.id, "Pset_A", "x"],
      [r.file.id, "Pset_A", "y"],
    ]);
  });

  it("re-upload by name: v2 latest, previous storeys and catalog replaced", async () => {
    const v1 = await appendIfcVersion(input());
    const v2 = await appendIfcVersion(
      input({
        contentHash: "h2",
        storeys: [{ name: "Ground", elevation: 0, expressId: 7, height: null }],
        propertyCatalog: [{ pset: "Pset_B", name: "z" }],
      }),
    );
    expect(v2.isNewFile).toBe(false);
    expect(v2.file.id).toBe(v1.file.id);
    expect(v2.version.versionNumber).toBe(2);
    const s = await snapshot();
    const byNum = Object.fromEntries(s.versions.map((v) => [v.versionNumber, v]));
    expect(byNum[1].isLatest).toBe(false);
    expect(byNum[2].isLatest).toBe(true);
    expect(s.files[0].currentVersionId).toBe(v2.version.id);
    expect(s.storeys.map((x) => [x.name, x.ifcVersionId])).toEqual([["Ground", v2.version.id]]);
    expect(s.catalog.map((c) => c.pset + "." + c.name)).toEqual(["Pset_B.z"]);
    expect(s.blobs.sort()).toEqual([`${v1.file.id}__v1`, `${v1.file.id}__v2`].sort());
  });

  it("replace by id appends to that file and throws for an unknown id", async () => {
    const v1 = await appendIfcVersion(input());
    const v2 = await appendIfcVersion(input({ ifcFileId: v1.file.id, fileName: "other-name.ifc" }));
    expect(v2.file.id).toBe(v1.file.id);
    expect(v2.file.name).toBe("model.ifc");
    expect(v2.version.versionNumber).toBe(2);
    await expect(appendIfcVersion(input({ ifcFileId: "nope" }))).rejects.toBeInstanceOf(IfcFileNotFoundError);
  });

  it("is atomic: a failure while writing storeys leaves the previous version latest and nothing new behind", async () => {
    const v1 = await appendIfcVersion(input());
    const before = await snapshot();

    vi.spyOn(db.storeys, "bulkAdd").mockRejectedValueOnce(new Error("disk on fire"));
    await expect(appendIfcVersion(input({ contentHash: "h2" }))).rejects.toThrow("disk on fire");

    const after = await snapshot();
    expect(after).toEqual(before);
    const latest = after.versions.filter((v) => v.isLatest);
    expect(latest.map((v) => v.id)).toEqual([v1.version.id]);
  });

  it("is atomic for a brand-new file too: a failed catalog write creates no file / version / blob", async () => {
    vi.spyOn(db.propertyCatalog, "bulkAdd").mockRejectedValueOnce(new Error("boom"));
    await expect(appendIfcVersion(input())).rejects.toThrow("boom");
    const s = await snapshot();
    expect(s).toEqual({ files: [], versions: [], storeys: [], catalog: [], blobs: [] });
  });

  it("duplicate storey names are disambiguated instead of failing the unique index", async () => {
    const r = await appendIfcVersion(
      input({
        storeys: [
          { name: "Level 1", elevation: 0, expressId: 1, height: null },
          { name: "Level 1", elevation: 3, expressId: 2, height: null },
          { name: "Level 1", elevation: 6, expressId: 3, height: null },
        ],
      }),
    );
    expect(r.storeyCount).toBe(3);
    const names = (await db.storeys.toArray()).sort((a, b) => a.elevation - b.elevation).map((s) => s.name);
    expect(names).toEqual(["Level 1", "Level 1 (2)", "Level 1 (3)"]);
    expect((await db.ifcVersions.get(r.version.id))!.storeyCount).toBe(3);
  });

  it("concurrent appends to one file mint distinct version numbers with exactly one latest", async () => {
    const results = await Promise.all([
      appendIfcVersion(input({ contentHash: "a" })),
      appendIfcVersion(input({ contentHash: "b" })),
      appendIfcVersion(input({ contentHash: "c" })),
    ]);
    const nums = results.map((r) => r.version.versionNumber).sort();
    expect(nums).toEqual([1, 2, 3]);
    expect(new Set(results.map((r) => r.file.id)).size).toBe(1);
    const versions = await db.ifcVersions.toArray();
    expect(versions.filter((v) => v.isLatest)).toHaveLength(1);
    const file = (await db.ifcFiles.toArray())[0];
    expect(versions.find((v) => v.isLatest)!.id).toBe(file.currentVersionId);
  });

  it("QuotaExceededError surfaces as a typed StorageQuotaExceededError, nothing persisted", async () => {
    const quota = Object.assign(new Error("The quota has been exceeded."), { name: "QuotaExceededError" });
    vi.spyOn(db.fragBlobs, "put").mockRejectedValueOnce(quota);
    const err = await appendIfcVersion(input()).catch((e) => e);
    expect(err).toBeInstanceOf(StorageQuotaExceededError);
    // Dexie wraps the DOMException; the original stays reachable.
    expect(isQuotaExceededError((err as StorageQuotaExceededError).cause)).toBe(true);
    expect(quota.name).toBe("QuotaExceededError");
    expect((await snapshot()).files).toEqual([]);
  });
});

describe("appendIfcVersion keeps the user's level work across versions (2026-11-14)", () => {
  it("moves extracted levels and the Get Levels selection to the new version's storeys by name", async () => {
    const v1 = await appendIfcVersion(input());
    const v1Storeys = await db.storeys.toArray();
    const L0 = v1Storeys.find((s) => s.name === "L0")!;
    const L1 = v1Storeys.find((s) => s.name === "L1")!;
    await db.extractedStoreys.bulkAdd([
      { id: "e0", buildingId: "b1", storeyId: L0.id, updatedAt: 1 },
      { id: "e1", buildingId: "b1", storeyId: L1.id, updatedAt: 1 },
    ]);
    await db.buildingLevelSelection.put({ buildingId: "b1", levelId: L1.id, selected: true, updatedAt: 1 });

    // v2: L1 kept (moved a bit), L0 dropped, L2 new
    await appendIfcVersion(
      input({
        ifcFileId: v1.file.id,
        contentHash: "h2",
        storeys: [
          { name: "L1", elevation: 3.1, expressId: 7, height: null },
          { name: "L2", elevation: 6, expressId: 8, height: null },
        ],
      }),
    );
    const v2Storeys = await db.storeys.toArray();
    const newL1 = v2Storeys.find((s) => s.name === "L1")!;
    expect(newL1.id).not.toBe(L1.id);

    const extracted = await db.extractedStoreys.toArray();
    expect(extracted.map((e) => e.storeyId)).toEqual([newL1.id]); // L1 kept, L0 gone
    const sel = await db.buildingLevelSelection.toArray();
    expect(sel).toEqual([expect.objectContaining({ buildingId: "b1", levelId: newL1.id, selected: true })]);
  });

  it("pairs same-named levels in elevation order", async () => {
    const { matchStoreysByName } = await import("../../src/db/appendIfcVersion");
    const m = matchStoreysByName(
      [
        { id: "oHigh", name: "Roof", elevation: 9 },
        { id: "oLow", name: "Roof", elevation: 6 },
      ],
      [
        { id: "nLow", name: "Roof", elevation: 6.2 },
        { id: "nHigh", name: "Roof", elevation: 9.1 },
      ],
    );
    expect(m.get("oLow")).toBe("nLow");
    expect(m.get("oHigh")).toBe("nHigh");
  });
});
