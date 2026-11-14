// __tests__/pipeline/replaceIfcVersionPsets.test.ts
//
// Regression: replaceIfcVersion used to convert the IFC WITHOUT the
// importer's addAllAttributes() / addAllRelations(), so a replaced
// version's .frag was missing every attribute / relation / entity
// class outside the importer's small default set (OwnerHistory,
// ObjectPlacement, classification + type relations, owner/person/
// organization entities, non-default property classes, ...). The
// properties panel (IfcViewer.getElementData) and the model property
// index (useModelPropertyIndex via the batched getItemsData) read
// psets + attributes from the .frag through IsDefinedBy.
//
// Both pipeline paths now use PIPELINE_IFC_IMPORT_OPTIONS; this test
// proves the replaced version's .frag holds the same psets, attributes
// and relations as the loadIfc one (and the full set, not the default).
//
// Real web-ifc + IfcImporter + Dexie (same stack as
// replaceIfcVersion.test.ts). The stored .frag of each version is
// opened with the fragments library's single-threaded model and
// queried with the EXACT getItemsData config the viewer uses.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as FRAGS from "@thatopen/fragments";

import { renderHook, act } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { useIfcPipeline } from "@ff/data/hooks";
import { listVersions } from "@ff/data/db/tables/ifcVersions";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";

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
  const p = await createProject({ name: "ReplacePsetsProject", metadata: {} });
  return createBuilding({ projectId: p.id, name: "ReplacePsetsBuilding", metadata: {} });
}

type Entity = Record<string, unknown>;

function scalar(e: Entity, key: string): unknown {
  const v = e[key];
  return v && typeof v === "object" && "value" in (v as object)
    ? (v as { value: unknown }).value
    : undefined;
}

/**
 * Per element: "<pset>.<prop>" names reachable through IsDefinedBy ->
 * HasProperties (the walk flattenItemData does for the properties
 * panel), plus the count of IsDefinedBy relations at all.
 */
async function readPsets(fragBytes: Uint8Array): Promise<{
  props: Map<number, string[]>;
  relationCount: number;
}> {
  const model = new FRAGS.SingleThreadedFragmentsModel("t", fragBytes, true);
  try {
    await model.ready;
    const ids = model.getItemsIdsWithGeometry();
    expect(ids.length).toBeGreaterThan(0);
    // Same config as IfcViewer.getElementData / the batched index.
    const data = (await model.getItemsData(ids, {
      attributesDefault: true,
      relations: { IsDefinedBy: { attributes: true, relations: true } },
    })) as unknown as Entity[];
    const props = new Map<number, string[]>();
    let relationCount = 0;
    data.forEach((item, i) => {
      const defs = item.IsDefinedBy;
      if (!Array.isArray(defs)) return;
      relationCount += defs.length;
      const names: string[] = [];
      for (const pset of defs as Entity[]) {
        const psetName = scalar(pset, "Name");
        const has = pset.HasProperties;
        if (typeof psetName !== "string" || !Array.isArray(has)) continue;
        for (const p of has as Entity[]) {
          const n = scalar(p, "Name");
          if (typeof n === "string") names.push(`${psetName}.${n}`);
        }
      }
      if (names.length > 0) props.set(ids[i], names.sort());
    });
    return { props, relationCount };
  } finally {
    model.dispose();
  }
}

/** Everything the .frag knows about its geometric elements. */
async function readFull(fragBytes: Uint8Array) {
  const model = new FRAGS.SingleThreadedFragmentsModel("f", fragBytes, true);
  try {
    await model.ready;
    const ids = model.getItemsIdsWithGeometry();
    const items = (await model.getItemsData(ids, {
      attributesDefault: true,
      relationsDefault: { attributes: true, relations: false },
    })) as unknown as Entity[];
    return {
      localIdCount: model.getLocalIds().length,
      categories: [...model.getCategories()].sort(),
      items,
    };
  } finally {
    model.dispose();
  }
}

async function fragOf(fragBlobKey: string): Promise<Uint8Array> {
  const blob = await getFragBlob(fragBlobKey);
  expect(blob).toBeDefined();
  return new Uint8Array(await blob!.arrayBuffer());
}

describe("replaceIfcVersion keeps property sets, attributes and relations in the .frag", () => {
  beforeAll(async () => {
    if (!db.isOpen()) await db.open();
  });
  beforeEach(async () => {
    await resetDb("replaceIfcVersion-psets");
  });
  afterAll(async () => {
    if (db.isOpen()) await db.close();
  });

  it("a replaced version's .frag carries the same psets / attributes / relations as loadIfc's", async () => {
    const building = await makeBuilding();
    const { result } = renderHook(() => useIfcPipeline());

    let v1: Awaited<ReturnType<typeof result.current.loadIfc>>;
    await act(async () => {
      v1 = await result.current.loadIfc(makeIfcFile("psets.ifc"), building.id);
    });
    let v2: Awaited<ReturnType<typeof result.current.replaceIfcVersion>>;
    await act(async () => {
      v2 = await result.current.replaceIfcVersion(v1!.ifcFileId, makeIfcFile("psets.ifc"));
    });
    expect(v2!.versionNumber).toBe(2);

    const versions = await listVersions(v1!.ifcFileId);
    const byNum = Object.fromEntries(versions.map((v) => [v.versionNumber, v]));
    const loaded = await readPsets(await fragOf(byNum[1].fragBlobKey));
    const replaced = await readPsets(await fragOf(byNum[2].fragBlobKey));

    // The replaced version has property sets + IsDefinedBy relations...
    expect(replaced.relationCount).toBeGreaterThan(0);
    expect(replaced.props.size).toBeGreaterThan(0);
    // ...and exactly the ones the original loadIfc version has.
    expect(replaced.relationCount).toBe(loaded.relationCount);
    expect([...replaced.props.entries()].sort((a, b) => a[0] - b[0])).toEqual(
      [...loaded.props.entries()].sort((a, b) => a[0] - b[0]),
    );

    // All attributes + all relations, not just the importer defaults:
    // same entities / categories / per-element data as loadIfc's .frag.
    const fullLoaded = await readFull(await fragOf(byNum[1].fragBlobKey));
    const fullReplaced = await readFull(await fragOf(byNum[2].fragBlobKey));
    expect(fullReplaced.localIdCount).toBe(fullLoaded.localIdCount);
    expect(fullReplaced.categories).toEqual(fullLoaded.categories);
    expect(fullReplaced.items).toEqual(fullLoaded.items);
    // Spot-check data only addAllAttributes()/addAllRelations() keep
    // (the old replace .frag lacked all of these).
    expect(fullReplaced.categories).toEqual(
      expect.arrayContaining([
        "IFCOWNERHISTORY",
        "IFCRELASSOCIATESCLASSIFICATION",
        "IFCRELDEFINESBYPROPERTIES",
      ]),
    );
    const keys = new Set(fullReplaced.items.flatMap((i) => Object.keys(i)));
    expect(keys).toContain("OwnerHistory");
    expect(keys).toContain("ObjectPlacement");
    expect(keys).toContain("ClassificationRefForObjects");
  }, 120_000);
});
