// __tests__/pipeline/ingestIfc.test.ts
//
// The IFC upload pipeline core (wave 63 review items 1, 2, 5, 6),
// driven through the in-thread import path with a mocked converter so
// each case controls exactly what the "IFC" contains.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../src/db/database";
import { ingestIfc, withImportLock } from "../../src/pipeline/ingestIfc";
import { IfcImportAbortedError } from "../../src/ifc/ifcImportClient";
import type { ConvertFn } from "../../src/ifc/ifcImportProtocol";
import type { ParsedIfc, ParsedStorey } from "../../src/ifc/ifcMetadata";
import { resetDb } from "../helpers/db";

function storey(name: string, elevation: number, expressId: number): ParsedStorey {
  return { name, elevation, expressId, height: null, guid: "", containedElementIds: [expressId * 10] };
}

/** Converter whose output is chosen per input (first byte = scenario). */
function makeConvert(byScenario: Record<number, ParsedIfc>) {
  let active = 0;
  let maxActive = 0;
  const calls: number[] = [];
  const convert: ConvertFn = async (bytes) => {
    active++;
    maxActive = Math.max(maxActive, active);
    calls.push(bytes[0]);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return {
      fragBytes: new Uint8Array([0xf, bytes[0]]),
      parsed: byScenario[bytes[0]] ?? byScenario[0],
      singlePass: true,
      convertMs: 1,
      metadataMs: 0,
    };
  };
  return { convert, calls, maxActive: () => maxActive };
}

const P1: ParsedIfc = {
  schema: "IFC4",
  buildings: [],
  storeys: [storey("L0", 0, 1), storey("L1", 3, 2)],
  propertyCatalog: [{ fileId: "pending", pset: "Pset_A", name: "x" }],
};
const P2: ParsedIfc = {
  schema: "IFC4",
  buildings: [],
  storeys: [storey("Ground", 0, 5)],
  propertyCatalog: [{ fileId: "pending", pset: "Pset_B", name: "y" }],
};
const DUP: ParsedIfc = {
  schema: "IFC4",
  buildings: [],
  // Two storeys with the same name, as some authoring tools emit.
  storeys: [storey("Level 1", 0, 1), storey("Level 1", 3, 2)],
  propertyCatalog: [],
};

/** A `size`-byte file whose first byte is `scenario`, tail byte `tail`. */
function ifcFile(name: string, scenario: number, size = 4, tail = 0): File {
  const b = new Uint8Array(size);
  b[0] = scenario;
  b[size - 1] = tail || b[size - 1];
  return new File([b], name);
}

let conv: ReturnType<typeof makeConvert>;
const hooks = () => ({ createWorker: () => null, convert: conv.convert });

beforeEach(async () => {
  await resetDb();
  conv = makeConvert({ 0: P1, 1: P1, 2: P2, 3: DUP });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestIfc", () => {
  it("re-upload of the same name (different bytes) replaces the previous version's storeys AND catalog", async () => {
    const r1 = await ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    const r2 = await ingestIfc({ file: ifcFile("m.ifc", 2), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    expect(r2.ifcFileId).toBe(r1.ifcFileId);
    expect(r2.versionNumber).toBe(2);
    expect(r2.isNewFile).toBe(false);

    const storeys = await db.storeys.toArray();
    expect(storeys.map((s) => [s.name, s.ifcVersionId])).toEqual([["Ground", r2.versionId]]);
    const catalog = await db.propertyCatalog.toArray();
    expect(catalog.map((c) => `${c.fileId}:${c.pset}.${c.name}`)).toEqual([`${r1.ifcFileId}:Pset_B.y`]);
    const latest = (await db.ifcVersions.toArray()).filter((v) => v.isLatest);
    expect(latest.map((v) => v.id)).toEqual([r2.versionId]);
    // The .frag blob holds the converter's bytes as-is.
    const blob = (await db.fragBlobs.get(`${r1.ifcFileId}__v2`))!.blob;
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0xf, 2]);
  });

  it("replace (byId) also replaces storeys + catalog and keeps the chain's name", async () => {
    const r1 = await ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    const r2 = await ingestIfc({ file: ifcFile("renamed.ifc", 2), target: { kind: "byId", ifcFileId: r1.ifcFileId }, dedupe: false, importHooks: hooks() });
    expect(r2.versionNumber).toBe(2);
    expect((await db.ifcFiles.get(r1.ifcFileId))!.name).toBe("m.ifc");
    expect((await db.storeys.toArray()).map((s) => s.name)).toEqual(["Ground"]);
    expect((await db.propertyCatalog.toArray()).map((c) => c.pset)).toEqual(["Pset_B"]);
  });

  it("dedupe uses the FULL file: same size + same first 64 KB but a different tail is a new version", async () => {
    const size = 70 * 1024;
    const a = ifcFile("big.ifc", 1, size, 1);
    const b = ifcFile("big.ifc", 1, size, 2); // differs only in the last byte
    const r1 = await ingestIfc({ file: a, target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    const r2 = await ingestIfc({ file: b, target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    expect(r2.versionNumber).toBe(2);
    expect(r2.versionId).not.toBe(r1.versionId);
    const hashes = (await db.ifcVersions.toArray()).map((v) => v.contentHash);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(true);
  });

  it("identical bytes return the latest version without converting again", async () => {
    const r1 = await ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    const r2 = await ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    expect(r2).toEqual({ ...r1, isNewFile: false });
    expect(conv.calls).toHaveLength(1);
    expect(await db.ifcVersions.count()).toBe(1);
  });

  it("concurrent imports of one file are serialised: distinct versions, no overlapping conversions", async () => {
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        ingestIfc({ file: ifcFile("m.ifc", n === 3 ? 0 : n), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() }),
      ),
    );
    expect(results.map((r) => r.versionNumber)).toEqual([1, 2, 3]);
    expect(new Set(results.map((r) => r.ifcFileId)).size).toBe(1);
    expect(conv.maxActive()).toBe(1);
    expect((await db.ifcVersions.toArray()).filter((v) => v.isLatest)).toHaveLength(1);
  });

  it("concurrent identical uploads: the second waits, then dedupes against the first", async () => {
    const [a, b] = await Promise.all([
      ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() }),
      ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() }),
    ]);
    expect(b.versionId).toBe(a.versionId);
    expect(conv.calls).toHaveLength(1);
  });

  it("an IFC with duplicate storey names imports (names disambiguated)", async () => {
    const r = await ingestIfc({ file: ifcFile("dup.ifc", 3), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    expect(r.storeyCount).toBe(2);
    const names = (await db.storeys.toArray()).sort((x, y) => x.elevation - y.elevation).map((s) => s.name);
    expect(names).toEqual(["Level 1", "Level 1 (2)"]);
  });

  it("an aborted import rejects with IfcImportAbortedError and persists nothing", async () => {
    const ctl = new AbortController();
    const p = ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, signal: ctl.signal, importHooks: hooks() });
    ctl.abort();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(IfcImportAbortedError);
    expect((err as IfcImportAbortedError).reason).toBe("aborted");
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.ifcFiles.count()).toBe(0);
  });

  it("a failed persist leaves no half-written version (previous stays latest)", async () => {
    const r1 = await ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() });
    vi.spyOn(db.propertyCatalog, "bulkAdd").mockRejectedValueOnce(new Error("write failed"));
    await expect(
      ingestIfc({ file: ifcFile("m.ifc", 2), target: { kind: "byName", buildingId: "b" }, dedupe: true, importHooks: hooks() }),
    ).rejects.toThrow("write failed");
    const versions = await db.ifcVersions.toArray();
    expect(versions.map((v) => [v.id, v.isLatest])).toEqual([[r1.versionId, true]]);
    expect((await db.storeys.toArray()).map((s) => s.ifcVersionId)).toEqual([r1.versionId, r1.versionId]);
  });

  it("replace of an unknown file id throws before converting", async () => {
    await expect(
      ingestIfc({ file: ifcFile("m.ifc", 1), target: { kind: "byId", ifcFileId: "nope" }, dedupe: false, importHooks: hooks() }),
    ).rejects.toThrow(/IfcFileRecord/);
    expect(conv.calls).toHaveLength(0);
  });
});

describe("withImportLock", () => {
  it("runs same-key work one at a time, other keys in parallel, and survives a failure", async () => {
    const log: string[] = [];
    const job = (key: string, tag: string, fail = false) =>
      withImportLock(key, async () => {
        log.push(`start ${tag}`);
        await new Promise((r) => setTimeout(r, 5));
        log.push(`end ${tag}`);
        if (fail) throw new Error(tag);
        return tag;
      });
    const res = await Promise.allSettled([job("k", "a", true), job("k", "b"), job("other", "c")]);
    expect(res.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
    expect(log.indexOf("end a")).toBeLessThan(log.indexOf("start b"));
    expect(log.indexOf("start c")).toBeLessThan(log.indexOf("end a"));
  });
});
