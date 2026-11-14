// apps/linkview/src/linkviewDataSource.ts
//
// The LinkView module's concrete implementation of the
// `ViewerToolsDataSource` DI boundary defined in @ff/viewer-tools.
//
// Mirrors `apps/models/src/modelsDataSource.ts` — same Dexie
// instance, same queries, same shape. A separate module-scoped
// instance so LinkView doesn't import from the Models module
// (which pulls in ModelsApp transitively via its barrel).
//
// Reactivity: these are plain async closures. @ff/viewer-tools wraps
// them in `useLiveQuery` at the call sites that need reactivity,
// and Dexie observes the global `db` instance regardless of where
// the query closure is defined.

import { db } from "@ff/data/db/database";

import type { FilterPresetRecord } from "@ff/types";

import type {
  ViewerToolsDataSource,
  AutoFilterEntry,
  PropertyCatalogEntryLite,
  StoreyLite,
} from "@ff/viewer-tools";

export const linkviewDataSource: ViewerToolsDataSource = {
  // ── Auto: Models ───────────────────────────────────────────────
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
    // Wave 33 — dedup levels by storey name (same fix as modelsDataSource).
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

  // ── Property catalog (schema-only) ────────────────────────────
  async queryPropertyCatalog(
    fileId: string,
  ): Promise<PropertyCatalogEntryLite[]> {
    const rows = await db.propertyCatalog.where({ fileId }).toArray();
    return rows.map((e) => ({ pset: e.pset, name: e.name }));
  },

  // ── Filter presets (not wired in LinkView MVP, but required by
  //    the ViewerToolsDataSource interface) ──────────────────────
  async queryFilterPresets(
    buildingId: string,
  ): Promise<FilterPresetRecord[]> {
    return db.filterPresets.where("buildingId").equals(buildingId).toArray();
  },

  async saveFilterPreset(
    _preset: FilterPresetRecord,
  ): Promise<FilterPresetRecord> {
    // LinkView doesn't wire filter persistence yet — the FiltersPanel
    // isn't mounted. If a future task adds it, wire upsertFilterPreset
    // from @ff/data.
    throw new Error("LinkView: filter preset persistence not wired");
  },

  async removeFilterPreset(_id: string): Promise<void> {
    throw new Error("LinkView: filter preset persistence not wired");
  },

  // ── File-name lookup (PropertiesDrawer title) ──────────────────
  async queryFileName(modelId: string): Promise<string | null> {
    const rec = await db.ifcFiles.get(modelId);
    return rec?.name ?? null;
  },

  // ── Storeys (level-map builder, not wired in LinkView) ─────────
  async queryStoreys(): Promise<StoreyLite[]> {
    const rows = await db.storeys.toArray();
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      sourceIfcFileId: s.sourceIfcFileId,
    }));
  },
};
