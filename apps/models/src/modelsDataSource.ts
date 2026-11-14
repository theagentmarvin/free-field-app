// apps/models/src/modelsDataSource.ts
//
// The Models module's concrete implementation of the
// `ViewerToolsDataSource` DI boundary defined in @ff/viewer-tools.
//
// ALL Dexie logic that used to live inline in the (now-extracted)
// FiltersPanel / hooks lives here: the ifcFiles→version subtitle
// mapping, the elevation sort for Levels, the filter-preset upsert/
// delete, the file-name lookup, and the storeys projection.
//
// Reactivity: these are plain async closures. @ff/viewer-tools wraps
// them in `useLiveQuery` at the call sites that need reactivity, and
// Dexie observes the global `db` instance regardless of where the
// query closure is defined — so live-query behavior is identical to
// the pre-extraction inline queries.

import { db } from "@ff/data/db/database";
import {
  deleteFilterPreset,
  upsertFilterPreset,
} from "@ff/data/db/tables/filterPresets";

import type { FilterPresetRecord } from "@ff/types";

import type {
  ViewerToolsDataSource,
  AutoFilterEntry,
  PropertyCatalogEntryLite,
  StoreyLite,
} from "@ff/viewer-tools";

/**
 * Build the Models-module data source. A single stable instance is
 * created at module scope so the object identity is constant across
 * renders — this keeps the `useLiveQuery` dependency arrays in the
 * package (which include `ds`) from re-subscribing on every render.
 */
export const modelsDataSource: ViewerToolsDataSource = {
  // ── Auto: Models ───────────────────────────────────────────────
  // One entry per ifcFile in the building, subtitle = version tag,
  // sorted by upload order (createdAt asc) so the "first" file is
  // the user's earliest upload (Task 20C-Part 1 §7 — the property
  // catalog seed depends on this ordering).
  async queryModels(buildingId: string): Promise<AutoFilterEntry[]> {
    const files = await db.ifcFiles
      .where("buildingId")
      .equals(buildingId)
      .toArray();
    const out: AutoFilterEntry[] = [];
    for (const f of files) {
      let subtitle = "(no version)";
      if (f.currentVersionId) {
        const v = await db.ifcVersions.get(f.currentVersionId);
        if (v) subtitle = `v${v.versionNumber}`;
      }
      out.push({
        id: f.id,
        label: f.name,
        subtitle,
        createdAt: f.createdAt,
      });
    }
    out.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return out;
  },

  // ── Auto: Levels ───────────────────────────────────────────────
  // One entry per storey of the latest version per file, sorted by
  // elevation asc (subtitle = elevation in metres, "X.XX m").
  async queryLevels(buildingId: string): Promise<AutoFilterEntry[]> {
    const files = await db.ifcFiles
      .where("buildingId")
      .equals(buildingId)
      .toArray();
    const latestVersionIds = files
      .map((f) => f.currentVersionId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (latestVersionIds.length === 0) return [];
    const all = await db.storeys
      .where("ifcVersionId")
      .anyOf(latestVersionIds)
      .toArray();
    // Wave 33 — dedup levels by storey name. Two federated models each
    // carrying "Level 1" are the SAME physical floor, not two levels:
    // merging here keeps one Level entry, and the level map
    // (useViewerExpressIdMaps) unions both models' express IDs under the
    // same name key so toggling it filters BOTH models' geometry.
    const byName = new Map<string, (typeof all)[number]>();
    for (const s of all) {
      const key = s.name.trim();
      if (!byName.has(key)) byName.set(key, s);
    }
    return Array.from(byName.values())
      .map((s) => ({
        id: s.name.trim(),
        label: s.name,
        subtitle: `${s.elevation.toFixed(2)} m`,
      }))
      .sort((a, b) => {
        const ea = parseFloat(a.subtitle);
        const eb = parseFloat(b.subtitle);
        if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) {
          return ea - eb;
        }
        return a.label.localeCompare(b.label);
      });
  },

  // ── Property catalog (schema-only) for one file ────────────────
  async queryPropertyCatalog(
    fileId: string,
  ): Promise<PropertyCatalogEntryLite[]> {
    const rows = await db.propertyCatalog.where({ fileId }).toArray();
    // Project to the package's "lite" shape (pset + name only).
    return rows.map((e) => ({ pset: e.pset, name: e.name }));
  },

  // ── Filter presets (Task 20D) ──────────────────────────────────
  async queryFilterPresets(
    buildingId: string,
  ): Promise<FilterPresetRecord[]> {
    return db.filterPresets.where("buildingId").equals(buildingId).toArray();
  },

  async saveFilterPreset(
    preset: FilterPresetRecord,
  ): Promise<FilterPresetRecord> {
    // upsertFilterPreset stamps createdAt/updatedAt and preserves
    // createdAt on update; the hook has already forced the correct
    // buildingId onto the record.
    return upsertFilterPreset(preset);
  },

  async removeFilterPreset(id: string): Promise<void> {
    await deleteFilterPreset(id);
  },

  // ── File-name lookup (PropertiesDrawer title) ──────────────────
  async queryFileName(modelId: string): Promise<string | null> {
    const rec = await db.ifcFiles.get(modelId);
    return rec?.name ?? null;
  },

  // ── Storeys (level-map builder in useViewerExpressIdMaps) ──────
  async queryStoreys(): Promise<StoreyLite[]> {
    const rows = await db.storeys.toArray();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      sourceIfcFileId: s.sourceIfcFileId,
    }));
  },
};
