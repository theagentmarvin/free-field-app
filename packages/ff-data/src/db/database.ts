// src/core/db/database.ts
//
// Dexie singleton for Free Field. See docs/SPEC-PHASE-1.md §4 for
// the v1 schema, docs/TASK-3-UI.md "Data model additions" for the
// v2 `buildingLevelSelection` table, and docs/TASK-11-PDF-CANVAS.md
// "Schema" for the v3 `pdfFiles` + `pdfVersions` + `pdfBlobs` stack.
//
// The database name is fixed ("free-field"). Tests isolate state by
// clearing tables (fake-indexeddb), not by renaming: a name setter
// could never take effect because the singleton below is created at
// module load, before any caller could run it.
//
// Multi-tab resilience (wave 63): see `installDatabaseLifecycle` at
// the bottom — a newer schema opened in another tab closes this
// connection and asks the user to reload instead of blocking it.

import Dexie, { type Table } from "dexie";
import type {
  ProjectRecord,
  BuildingRecord,
  IfcFileRecord,
  IfcVersionRecord,
  StoreyRecord,
  ExtractedStoreyRecord,
  FragBlobRecord,
  PdfFileRecord,
  PdfVersionRecord,
  PdfBlobRecord,
  CalibrationRecord,
  PdfFolderRecord,
  PdfFolderAssignmentRecord,
  OutboxRecord,
  TaskDraftRecord,
} from "@ff/types";
import type { BuildingLevelSelectionRecord } from "@ff/types";
import type { PropertyCatalogEntry } from "@ff/types";
import type { FilterPresetRecord } from "@ff/types";
import type { ViewerViewpointRecord } from "@ff/types";

export const DATABASE_NAME = "free-field";

/**
 * Phase 1c sync bookkeeping row (Dexie v11 `syncState`). One row per
 * `cursor:{projectId}:{collection}` (newest server `updatedAt` applied, epoch
 * ms) and one per `publish:{projectId}` (first-upload decision).
 */
export interface SyncStateRecord {
  key: string;
  projectId: string;
  /** `cursor:*` rows: newest applied server updatedAt (epoch ms). */
  cursorMs?: number;
  /** `publish:*` rows. */
  publishState?: "pending" | "published" | "declined";
  /** `publish:*` rows: epoch ms when sync first armed for this project. */
  armedAt?: number;
}

export class ProjectDatabase extends Dexie {
  projects!: Table<ProjectRecord, string>;
  buildings!: Table<BuildingRecord, string>;
  ifcFiles!: Table<IfcFileRecord, string>;
  ifcVersions!: Table<IfcVersionRecord, string>;
  storeys!: Table<StoreyRecord, string>;
  extractedStoreys!: Table<ExtractedStoreyRecord, string>;
  fragBlobs!: Table<FragBlobRecord, string>;
  buildingLevelSelection!: Table<BuildingLevelSelectionRecord, [string, string]>;
  // v3 — added in Task 11. See docs/TASK-11-PDF-CANVAS.md "Schema".
  // Mirror the IFC stack: a logical file row per (buildingId, name)
  // pair, an unbounded chain of version rows, and a Blob store for
  // the raw PDF bytes. The `[pdfFileId+versionNumber]` compound
  // index makes "latest version for a file" a cheap query and the
  // unique constraint catches accidental double-inserts.
  pdfFiles!: Table<PdfFileRecord, string>;
  pdfVersions!: Table<PdfVersionRecord, string>;
  pdfBlobs!: Table<PdfBlobRecord, string>;
  // v4 — added in Task 12a Part 2 (Calibration Wizard). See
  // docs/TASK-12a-CALIBRATION-WIZARD.md "Data layer". One row
  // per (pdfFileId, storeyName) pair. The compound indexes
  // serve three live-query shapes:
  //   - [pdfFileId+storeyName] → unique row lookup + dedup
  //   - [projectId+storeyName] → "all calibrations for this
  //                              level across PDFs"
  //   - [projectId+pdfFileId]  → "all calibrations for this PDF"
  calibrations!: Table<CalibrationRecord, string>;
  // v5 — added in Task 20C Part 1 (Property Catalog). See
  // docs/task-20c-part-1-property-catalog.md §1. Schema-only
  // index of (pset, name) pairs per file. The compound primary
  // key `[fileId+pset+name]` is the natural unique key — Dexie
  // dedups at the DB level on bulkAdd, so a re-extraction is
  // idempotent without JS-level dedup. No values, no element
  // applicability, no IFC schema version metadata.
  propertyCatalog!: Table<PropertyCatalogEntry, [string, string, string]>;
  // v6 — added in Task 20D (filter parity). See
  // the Task 20D filter spec §"Dexie Persistence". One
  // row per saved user filter preset. The compound
  // `[buildingId+updatedAt]` powers the live-query
  // "most-recently-saved presets per building" shape used by
  // apps/models/src/hooks/useFilterPresetsForBuilding.ts. The
  // single-field `buildingId` secondary index supports the
  // cascade-delete helper in
  // apps/settings/src/core/db/tables/filterPresets.ts.
  filterPresets!: Table<FilterPresetRecord, string>;
  // v8 — added in Task 20F (PDF folders). See
  // docs/task-20f-pdf-folders.md §"Schema". Two new tables, no
  // changes to v1..v6. The `pdfFolders.parentId` self-FK lets us
  // nest folders arbitrarily deep; the compound
  // `[projectId+parentId]` powers the live-query "all root-level
  // folders for this project" + "all children of this folder"
  // shapes used by useFolderTree. The unique single-field
  // `pdfFolderAssignments.pdfFileId` index enforces
  // one-folder-per-PDF semantics at the DB level (a re-assign
  // must delete the prior row first).
  pdfFolders!: Table<PdfFolderRecord, string>;
  pdfFolderAssignments!: Table<PdfFolderAssignmentRecord, string>;
  // v9 — tasks module Day 1 (plan §2.4, task-39). Two new tables, no
  // changes to v1..v8. The outbox is the ONLY client-side write path
  // borrowed from Commercial Viewer (cloud-first: no read mirror —
  // Firestore's own IndexedDB persistence serves warm reads); its
  // `state` index serves the drain query and the outbox-count chip.
  // `drafts` is crash-recovery compose state (§7 screen 2).
  outbox!: Table<OutboxRecord, string>;
  drafts!: Table<TaskDraftRecord, string>;
  // v10 — Wave 13 saved viewpoints. One new table, no changes to
  // v1..v9. Demo AND cloud mode both persist locally for now (cloud
  // sync is a future schema wave). `projectId` powers the per-project
  // list + cascade delete; `[projectId+createdAt]` powers the capped
  // list shape (oldest-first eviction at 12/project).
  viewerViewpoints!: Table<ViewerViewpointRecord, string>;
  // v11 — Phase 1c sync bookkeeping (down-sync cursors, first-upload
  // decision). Local only; never synced.
  syncState!: Table<SyncStateRecord, string>;

  /** `name` is overridable so tests (and the sync integration suite) can
   *  open several independent "devices" in one process. */
  constructor(name: string = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      projects: "&id, name, createdAt",
      buildings: "&id, projectId, name, &[projectId+name]",
      ifcFiles: "&id, buildingId, name, &[buildingId+name]",
      ifcVersions:
        "&id, ifcFileId, versionNumber, &[ifcFileId+versionNumber], isLatest",
      storeys: "&id, buildingId, ifcVersionId, name, &[ifcVersionId+name]",
      extractedStoreys: "&id, buildingId, storeyId, &[buildingId+storeyId]",
      fragBlobs: "&key",
    });
    // v2 — added in Task 3. See docs/TASK-3-UI.md "Data model additions".
    // No changes to existing tables. The `[buildingId+levelId]` compound
    // key enforces the (one row per pair) invariant; the secondary
    // indexes on each side let us query "all storeys checked for this
    // building" and "which buildings have touched this storey" cheaply.
    this.version(2).stores({
      buildingLevelSelection:
        "&[buildingId+levelId], buildingId, levelId",
    });
    // v3 — added in Task 11. See docs/TASK-11-PDF-CANVAS.md "Schema".
    // Three new tables, no changes to v1/v2 tables. The
    // `[buildingId+name]` compound on `pdfFiles` is the version key
    // (one PdfFileRecord per (building, filename)). The
    // `[pdfFileId+versionNumber]` compound on `pdfVersions` is the
    // uniqueness constraint for the version chain.
    this.version(3).stores({
      pdfFiles: "&id, buildingId, name, &[buildingId+name]",
      pdfVersions:
        "&id, pdfFileId, versionNumber, &[pdfFileId+versionNumber], isLatest",
      pdfBlobs: "&key",
    });
    // v4 — added in Task 12a Part 2. One new table, no changes to
    // v1/v2/v3. The [projectId+storeyName] compound indexes the
    // common query "all calibrations for this storey across PDFs
    // in this project"; the [projectId+pdfFileId] compound indexes
    // the inverse "all storeys mapped to this PDF in this
    // project". The unique (non-compound) primary key is `id`.
    this.version(4).stores({
      // [pdfFileId+storeyName] is the wizard's lookup key —
      // getCalibrationForPdfAndStorey uses it. The other two
      // compounds serve the live-query indexes (byStoreyName /
      // byPdfFileId).
      calibrations:
        "&id, projectId, pdfFileId, storeyName, [pdfFileId+storeyName], [projectId+storeyName], [projectId+pdfFileId]",
    });
    // v5 — added in Task 20C Part 1. One new table, no changes to
    // v1..v4. The compound primary key `[fileId+pset+name]` is
    // declared with `&` (unique) so bulkAdd silently dedupes on
    // re-extraction. The single-field secondary indexes let us
    // query "all catalog rows referencing this pset" / "all rows
    // for this property name" cheaply without going through the
    // compound.
    this.version(5).stores({
      propertyCatalog:
        "&[fileId+pset+name], fileId, pset, name",
    });
    // v6 — added in Task 20D (filter parity). One new table, no
    // changes to v1..v5. The primary key is `id` (uuid). The
    // compound index `[buildingId+updatedAt]` powers the live-query
    // in apps/models/src/hooks/useFilterPresetsForBuilding.ts;
    // `buildingId` alone supports the cascade-delete helper.
    this.version(6).stores({
      filterPresets:
        "&id, buildingId, updatedAt, [buildingId+updatedAt]",
    });
    // v8 — added in Task 20F (PDF folders). Two new tables, no
    // changes to v1..v6. The `&pdfFileId` on `pdfFolderAssignments`
    // is the unique single-field index that enforces one folder
    // per PDF (assigning a different folder replaces the row).
    // The `parentId` index on `pdfFolders` is the self-FK for
    // nesting; the `[projectId+parentId]` compound powers the
    // "children of folder X in project Y" live-query. Uniqueness
    // of (projectId, parentId, name) is enforced at the
    // application layer via `findPdfFolderByName` — Dexie's
    // compound-unique support is brittle when one of the key
    // parts can be null (`parentId` for root folders), and the
    // expected folder count per project is small enough that
    // an in-app scan is cheaper than a schema-level constraint.
    this.version(8).stores({
      pdfFolders:
        "&id, projectId, parentId, [projectId+parentId]",
      pdfFolderAssignments:
        "&id, &pdfFileId, folderId, [pdfFileId+folderId]",
    });
    // v9 — tasks module. Claimed HERE deliberately: the "in-flight v9"
    // in repo AGENTS.md is the useProjectId() UI-lift (see
    // docs/migration/dexie-v9.md) which changes query KEYS only — no
    // stores() — so the version number was free. Never stack a second
    // bump for the same weekend.
    this.version(9).stores({
      outbox: "&id, state, kind, projectId, createdAt",
      drafts: "&id, projectId, updatedAt",
    });
    // v10 — saved 3D viewpoints (Wave 13). One new table, no changes
    // to v1..v9. `[projectId+createdAt]` is a regular compound index
    // (not unique) — eviction deletes by `id`, not by the compound.
    this.version(10).stores({
      viewerViewpoints: "&id, projectId, createdAt, [projectId+createdAt]",
    });
    // v11 — Phase 1c sync bookkeeping. One new table, no changes to
    // v1..v10.
    this.version(11).stores({
      syncState: "&key, projectId",
    });
  }
}

/** App-wide Dexie singleton. */
export const db = new ProjectDatabase();

// ---------- Lifecycle: versionchange / blocked ----------

/**
 * - "versionchange": another tab opened a NEWER schema. This tab has
 *   closed its connection (so the other tab's upgrade can proceed) and
 *   must reload to pick up the new code.
 * - "blocked": THIS tab wants to upgrade but an older tab still holds
 *   the database open; the upgrade waits until that tab closes/reloads.
 */
export type DatabaseLifecycleEvent =
  | { type: "versionchange"; newVersion: number | null }
  | { type: "blocked" };

type LifecycleListener = (e: DatabaseLifecycleEvent) => void;
const lifecycleListeners = new Set<LifecycleListener>();

/**
 * Subscribe to database lifecycle events (e.g. to show a "reload"
 * banner). While at least one listener is registered the built-in
 * fallback prompt is suppressed. Returns the unsubscribe function.
 */
export function onDatabaseLifecycle(listener: LifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

function emitLifecycle(e: DatabaseLifecycleEvent): void {
  if (lifecycleListeners.size > 0) {
    for (const l of lifecycleListeners) {
      try {
        l(e);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[ff-data] lifecycle listener failed:", err);
      }
    }
    return;
  }
  // No UI subscribed: fall back to the browser's own prompt.
  if (e.type === "versionchange") {
    // eslint-disable-next-line no-console
    console.warn("[ff-data] database upgraded in another tab; connection closed");
    const g = globalThis as {
      confirm?: (m: string) => boolean;
      location?: { reload?: () => void };
    };
    if (typeof g.confirm === "function" && typeof g.location?.reload === "function") {
      try {
        if (
          g.confirm(
            "FreeField was updated in another tab. Reload this tab to keep working with your data?",
          )
        ) {
          g.location.reload();
        }
      } catch {
        /* jsdom / headless: no dialogs */
      }
    }
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[ff-data] database upgrade blocked by another open FreeField tab; close or reload the other tabs",
    );
  }
}

/** Wire versionchange / blocked handling on a Dexie instance. */
export function installDatabaseLifecycle(target: Dexie): void {
  target.on("versionchange", (event: IDBVersionChangeEvent) => {
    // Close first: an open connection would block the other tab's
    // upgrade (and its own "blocked" prompt) indefinitely.
    target.close();
    emitLifecycle({ type: "versionchange", newVersion: event?.newVersion ?? null });
    // false = we handled it (Dexie skips its default handling).
    return false;
  });
  target.on("blocked", () => {
    emitLifecycle({ type: "blocked" });
  });
}

installDatabaseLifecycle(db);

// ---------- Persistent storage ----------

let persistRequested: Promise<boolean> | null = null;

/**
 * Ask the browser to make this origin's storage persistent (exempt
 * from eviction under storage pressure). Called once after the first
 * successful import — the moment the user has data worth keeping.
 * Idempotent; resolves false where the API is missing or refused.
 */
export function requestPersistentStorage(): Promise<boolean> {
  if (persistRequested) return persistRequested;
  const storage = (globalThis as {
    navigator?: { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } };
  }).navigator?.storage;
  if (!storage?.persist) {
    persistRequested = Promise.resolve(false);
    return persistRequested;
  }
  persistRequested = (async () => {
    try {
      if (storage.persisted && (await storage.persisted())) return true;
      return await storage.persist!();
    } catch {
      return false;
    }
  })();
  return persistRequested;
}

/** Test-only: forget a previous persist() request. */
export function __resetPersistRequestForTests(): void {
  persistRequested = null;
}
