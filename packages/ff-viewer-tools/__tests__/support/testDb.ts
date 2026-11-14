// packages/ff-viewer-tools/__tests__/support/testDb.ts
//
// A local Dexie instance + a Dexie-backed ViewerToolsDataSource double
// for package tests.
//
// The package source is Dexie-free by design (it consumes an injected
// `ViewerToolsDataSource`). But some moved tests assert LIVE-QUERY
// REACTIVITY — e.g. usePropertyCatalog test (c): "re-fires when a new
// row is added". A pure single-shot mock can't reproduce that, because
// `useLiveQuery` only re-runs when Dexie's global write-observer fires.
//
// So the test double is backed by a real (fake-indexeddb) Dexie whose
// schema mirrors the two tables the tests touch (propertyCatalog v5,
// filterPresets v6). Writing to `testDb.propertyCatalog` from a test
// triggers the same global observation that drives the hook's live
// query — faithful to the production reactivity contract documented in
// src/dataSource.ts.

import Dexie, { type Table } from "dexie";

import type { FilterPresetRecord } from "@ff/types";
import type {
  ViewerToolsDataSource,
  AutoFilterEntry,
  PropertyCatalogEntryLite,
  StoreyLite,
} from "../../src/dataSource";

// ── Local record shapes (mirror apps/settings core types) ──────────
export interface TestPropertyCatalogEntry {
  fileId: string;
  pset: string;
  name: string;
}

export interface TestStoreyRecord {
  id: string;
  name: string;
  sourceIfcFileId: string;
  ifcVersionId: string;
  elevation: number;
}

export interface TestIfcFileRecord {
  id: string;
  buildingId: string;
  name: string;
  currentVersionId: string;
  createdAt: number;
}

export interface TestIfcVersionRecord {
  id: string;
  versionNumber: number;
}

class TestDb extends Dexie {
  propertyCatalog!: Table<TestPropertyCatalogEntry, [string, string, string]>;
  filterPresets!: Table<FilterPresetRecord, string>;
  storeys!: Table<TestStoreyRecord, string>;
  ifcFiles!: Table<TestIfcFileRecord, string>;
  ifcVersions!: Table<TestIfcVersionRecord, string>;

  constructor() {
    super("ff-viewer-tools-test");
    // Schema mirrors the production keys the tested queries rely on:
    //   propertyCatalog: v5 "&[fileId+pset+name], fileId, pset, name"
    //   filterPresets:   v6 "&id, buildingId, updatedAt, [buildingId+updatedAt]"
    this.version(1).stores({
      propertyCatalog: "&[fileId+pset+name], fileId, pset, name",
      filterPresets: "&id, buildingId, updatedAt, [buildingId+updatedAt]",
      storeys: "&id, ifcVersionId, sourceIfcFileId",
      ifcFiles: "&id, buildingId, currentVersionId",
      ifcVersions: "&id",
    });
  }
}

/** App-wide test Dexie singleton. */
export const testDb = new TestDb();

/**
 * A ViewerToolsDataSource whose closures read/write `testDb`. Its
 * methods replicate the app adapter's (apps/models/src/modelsDataSource.ts)
 * projection + sort logic so tests exercise the real query contract.
 */
export const testDataSource: ViewerToolsDataSource = {
  async queryModels(buildingId: string): Promise<AutoFilterEntry[]> {
    const files = await testDb.ifcFiles
      .where("buildingId")
      .equals(buildingId)
      .toArray();
    const out: AutoFilterEntry[] = [];
    for (const f of files) {
      let subtitle = "(no version)";
      if (f.currentVersionId) {
        const v = await testDb.ifcVersions.get(f.currentVersionId);
        if (v) subtitle = `v${v.versionNumber}`;
      }
      out.push({ id: f.id, label: f.name, subtitle, createdAt: f.createdAt });
    }
    out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return out;
  },

  async queryLevels(_buildingId: string): Promise<AutoFilterEntry[]> {
    // The moved FiltersPanel test doesn't exercise Levels directly;
    // return an elevation-sorted projection of all storeys for
    // completeness / future tests.
    const all = await testDb.storeys.toArray();
    return all
      .map((s) => ({
        id: s.id,
        label: s.name,
        subtitle: `${s.elevation.toFixed(2)} m`,
      }))
      .sort((a, b) => parseFloat(a.subtitle) - parseFloat(b.subtitle));
  },

  async queryPropertyCatalog(
    fileId: string,
  ): Promise<PropertyCatalogEntryLite[]> {
    const rows = await testDb.propertyCatalog.where({ fileId }).toArray();
    return rows.map((e) => ({ pset: e.pset, name: e.name }));
  },

  async queryFilterPresets(
    buildingId: string,
  ): Promise<FilterPresetRecord[]> {
    return testDb.filterPresets
      .where("buildingId")
      .equals(buildingId)
      .toArray();
  },

  async saveFilterPreset(
    preset: FilterPresetRecord,
  ): Promise<FilterPresetRecord> {
    // Mirror upsertFilterPreset: preserve createdAt on update, always
    // re-stamp updatedAt.
    const existing = await testDb.filterPresets.get(preset.id);
    const now = Date.now();
    const next: FilterPresetRecord = existing
      ? { ...existing, ...preset, createdAt: existing.createdAt, updatedAt: now }
      : {
          ...preset,
          createdAt: preset.createdAt ?? now,
          updatedAt: now,
        };
    await testDb.filterPresets.put(next);
    return next;
  },

  async removeFilterPreset(id: string): Promise<void> {
    await testDb.filterPresets.delete(id);
  },

  async queryFileName(modelId: string): Promise<string | null> {
    const rec = await testDb.ifcFiles.get(modelId);
    return rec?.name ?? null;
  },

  async queryStoreys(): Promise<StoreyLite[]> {
    const rows = await testDb.storeys.toArray();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      sourceIfcFileId: s.sourceIfcFileId,
    }));
  },
};

/** Clear every table between tests. */
export async function clearTestDb(): Promise<void> {
  if (!testDb.isOpen()) await testDb.open();
  await testDb.transaction(
    "rw",
    [
      testDb.propertyCatalog,
      testDb.filterPresets,
      testDb.storeys,
      testDb.ifcFiles,
      testDb.ifcVersions,
    ],
    async () => {
      await testDb.propertyCatalog.clear();
      await testDb.filterPresets.clear();
      await testDb.storeys.clear();
      await testDb.ifcFiles.clear();
      await testDb.ifcVersions.clear();
    },
  );
}
