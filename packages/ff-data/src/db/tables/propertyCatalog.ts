// src/core/db/tables/propertyCatalog.ts
//
// Dexie helpers for the v5 `propertyCatalog` table. The catalog is a
// schema-only index of (pset, name) pairs found in each IFC file,
// extracted during `parseIfc()` (folded into the same IfcAPI session
// per the Critic's recommendation) and persisted at the tail of
// `loadIfc()`.
//
// Two helpers:
//   - `createPropertyCatalog(entries)` — bulk insert. Compound
//     `[fileId+pset+name]` primary key makes this idempotent: a
//     re-extraction that produces the same rows will silently no-op
//     (no try/catch needed; `bulkAdd` ignores primary-key collisions).
//   - `clearPropertyCatalog(fileId)` — wipe all catalog rows for a
//     given logical file. Called at the top of `replaceIfcVersion()`
//     so a version bump leaves no stale rows.
//
// See docs/task-20c-part-1-property-catalog.md §3, §6.

import { db } from "../database";
import type { PropertyCatalogEntry } from "@ff/types";

/**
 * Persist a batch of catalog entries to Dexie. No-op on empty input.
 *
 * Two-stage dedup so the helper is safe to call repeatedly:
 *   1. Within-batch dedup (cheap Set pass) — collapses duplicate
 *      rows inside a single call (defensive; `parseIfc` already
 *      dedups by pset+name during its walk).
 *   2. Against-existing dedup — we read the file's current catalog
 *      rows and skip any compound-key collisions before bulkAdd.
 *      This avoids the Dexie 4 `ConstraintError` thrown by `bulkAdd`
 *      on primary-key conflicts (verified empirically — `bulkAdd`
 *      is strict; `bulkPut` is the upserting cousin).
 *
 * The "read first, then add" round-trip is one extra `toArray()`
 * per upload, well within the cost envelope (~5–10MB catalog per
 * 200MB IFC per the spec).
 */
export async function createPropertyCatalog(
  entries: PropertyCatalogEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  // Group by fileId so we only read each file's catalog once when
  // the caller hands us entries for multiple files in one call.
  // (Today the only caller stamps a single fileId, but the helper
  // shape should match the table shape.)
  const byFile = new Map<string, PropertyCatalogEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.fileId) ?? [];
    list.push(e);
    byFile.set(e.fileId, list);
  }
  for (const [fileId, list] of byFile) {
    // 1. Within-batch dedup.
    const seenLocal = new Set<string>();
    const deduped: PropertyCatalogEntry[] = [];
    for (const e of list) {
      const key = `${e.pset}\x00${e.name}`;
      if (seenLocal.has(key)) continue;
      seenLocal.add(key);
      deduped.push(e);
    }
    if (deduped.length === 0) continue;
    // 2. Against-existing dedup — pull the file's existing catalog
    // rows once (cheap; one `fileId` index hit) and subtract.
    const existing = await db.propertyCatalog
      .where({ fileId })
      .toArray();
    const existingKeys = new Set(
      existing.map((e) => `${e.pset}\x00${e.name}`),
    );
    const fresh = deduped.filter(
      (e) => !existingKeys.has(`${e.pset}\x00${e.name}`),
    );
    if (fresh.length === 0) continue;
    await db.propertyCatalog.bulkAdd(fresh);
  }
}

/**
 * Delete every catalog row for the given logical file. Used by
 * `replaceIfcVersion()` to wipe the previous version's catalog
 * before re-extracting. We key by fileId (NOT versionId) because
 * the catalog's contract is "at most one row per (fileId, pset,
 * name), always reflecting the latest version".
 */
export async function clearPropertyCatalog(fileId: string): Promise<void> {
  await db.propertyCatalog.where({ fileId }).delete();
}