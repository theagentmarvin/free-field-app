// packages/ff-data/src/db/legacyProjectRekey.ts
//
// Wave 65 (Phase 1 foundation) — one-time local re-key.
//
// Before Phase 1 every local row was written under the implicit
// project `LEGACY_DEFAULT_PROJECT_ID` ("default-project"). On the first
// load with a REAL current project, the shell calls
// `rekeyLegacyProjectData` once: every row that still carries the
// legacy id is moved to that project, in ONE Dexie transaction, so the
// user's existing buildings / PDFs / calibrations / folders /
// viewpoints / task outbox + drafts show up in their real project.
//
// Rules (docs/SPEC-PHASE-1.md §7):
//   - Demo mode never runs it (the demo project IS the legacy id).
//   - Idempotent: a localStorage marker keyed by uid + project records
//     the run; and the move itself only touches rows still on the
//     legacy id, so a re-run (marker lost) moves nothing.
//   - Several projects: whichever project is chosen FIRST after the
//     upgrade gets the data. Later choices find nothing to move.
//   - No schema change: the marker lives in localStorage, so the Dexie
//     version is not bumped.
//
// Tables re-keyed (every table with a `projectId` column, plus the
// `projects` row itself): projects, buildings, calibrations,
// pdfFolders, viewerViewpoints, outbox (row + payload), drafts.
// Child tables (ifcFiles, ifcVersions, storeys, pdfFiles, pdfVersions,
// blobs, …) hang off `buildingId` and move with their building.
// The demo-only task database (@ff/tasks demoTaskDb) is never touched.

import { LEGACY_DEFAULT_PROJECT_ID } from "@ff/types";

import { db as appDb, type ProjectDatabase } from "./database";

/** localStorage key prefix of the per-(uid, project) run marker. */
export const LEGACY_REKEY_MARKER_PREFIX = "ff-legacy-project-rekey:v1";

export function legacyRekeyMarkerKey(uid: string, projectId: string): string {
  return `${LEGACY_REKEY_MARKER_PREFIX}:${uid}:${projectId}`;
}

export type LegacyRekeyTable =
  | "projects"
  | "buildings"
  | "calibrations"
  | "pdfFolders"
  | "viewerViewpoints"
  | "outbox"
  | "drafts";

export type LegacyRekeyStatus =
  /** Rows were moved. */
  | "rekeyed"
  /** Ran, but no row carried the legacy id. */
  | "nothing-to-move"
  /** The marker for this uid + project exists: not run again. */
  | "already-done"
  /** Demo mode: never re-key. */
  | "skipped-demo"
  /** No uid / no project / target is the legacy id itself. */
  | "skipped-invalid";

export interface LegacyRekeyResult {
  status: LegacyRekeyStatus;
  moved: Record<LegacyRekeyTable, number>;
}

/** The subset of `Storage` the marker needs (injectable for tests). */
export interface RekeyMarkerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LegacyRekeyOptions {
  uid: string;
  /** The real current project the legacy rows move to. */
  projectId: string;
  /** Demo mode → skipped. */
  isDemo: boolean;
  /** Defaults to the app-wide Dexie singleton. */
  database?: ProjectDatabase;
  /** Defaults to `globalThis.localStorage` (null = no marker). */
  storage?: RekeyMarkerStorage | null;
}

function emptyMoved(): Record<LegacyRekeyTable, number> {
  return {
    projects: 0,
    buildings: 0,
    calibrations: 0,
    pdfFolders: 0,
    viewerViewpoints: 0,
    outbox: 0,
    drafts: 0,
  };
}

function defaultStorage(): RekeyMarkerStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readMarker(storage: RekeyMarkerStorage | null, key: string): boolean {
  try {
    return storage?.getItem(key) != null;
  } catch {
    return false;
  }
}

function writeMarker(
  storage: RekeyMarkerStorage | null,
  key: string,
  moved: Record<LegacyRekeyTable, number>,
): void {
  try {
    storage?.setItem(key, JSON.stringify({ at: Date.now(), moved }));
  } catch {
    /* storage unavailable — the move itself is idempotent */
  }
}

/** A name not yet used in `taken` ("Tower" → "Tower (local)" → "Tower (local 2)"). */
function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  let candidate = `${name} (local)`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name} (local ${n})`;
  return candidate;
}

// Concurrent calls for the same (uid, project) share one run.
const inFlight = new Map<string, Promise<LegacyRekeyResult>>();

/**
 * Move every local row still keyed to the legacy project to
 * `projectId`, once. See the file header for the rules.
 */
export function rekeyLegacyProjectData(
  options: LegacyRekeyOptions,
): Promise<LegacyRekeyResult> {
  const { uid, projectId, isDemo } = options;
  if (isDemo) return Promise.resolve({ status: "skipped-demo", moved: emptyMoved() });
  if (!uid || !projectId || projectId === LEGACY_DEFAULT_PROJECT_ID) {
    return Promise.resolve({ status: "skipped-invalid", moved: emptyMoved() });
  }
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const key = legacyRekeyMarkerKey(uid, projectId);
  if (readMarker(storage, key)) {
    return Promise.resolve({ status: "already-done", moved: emptyMoved() });
  }
  const running = inFlight.get(key);
  if (running) return running;

  const run = runRekey(options.database ?? appDb, projectId)
    .then((moved) => {
      writeMarker(storage, key, moved);
      const total = Object.values(moved).reduce((a, b) => a + b, 0);
      return { status: total > 0 ? "rekeyed" : "nothing-to-move", moved } as LegacyRekeyResult;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, run);
  return run;
}

async function runRekey(
  database: ProjectDatabase,
  projectId: string,
): Promise<Record<LegacyRekeyTable, number>> {
  const legacy = LEGACY_DEFAULT_PROJECT_ID;
  const moved = emptyMoved();

  await database.transaction(
    "rw",
    [
      database.projects,
      database.buildings,
      database.calibrations,
      database.pdfFolders,
      database.viewerViewpoints,
      database.outbox,
      database.drafts,
    ],
    async () => {
      // The project row itself: keep its name/metadata under the new id
      // unless the target project already has a local row.
      const legacyProject = await database.projects.get(legacy);
      if (legacyProject) {
        const target = await database.projects.get(projectId);
        if (!target) {
          await database.projects.add({ ...legacyProject, id: projectId });
        }
        await database.projects.delete(legacy);
        moved.projects = 1;
      }

      // Buildings: `&[projectId+name]` is unique, so a name clash with a
      // building the target project already has locally gets a suffix
      // instead of aborting the whole transaction.
      const legacyBuildings = await database.buildings.where("projectId").equals(legacy).toArray();
      if (legacyBuildings.length > 0) {
        const taken = new Set(
          (await database.buildings.where("projectId").equals(projectId).toArray()).map((b) => b.name),
        );
        for (const b of legacyBuildings) {
          const name = freeName(b.name, taken);
          taken.add(name);
          await database.buildings.update(b.id, name === b.name ? { projectId } : { projectId, name });
        }
        moved.buildings = legacyBuildings.length;
      }

      moved.calibrations = await database.calibrations
        .where("projectId")
        .equals(legacy)
        .modify({ projectId });
      moved.pdfFolders = await database.pdfFolders
        .where("projectId")
        .equals(legacy)
        .modify({ projectId });
      moved.viewerViewpoints = await database.viewerViewpoints
        .where("projectId")
        .equals(legacy)
        .modify({ projectId });
      moved.drafts = await database.drafts.where("projectId").equals(legacy).modify({ projectId });
      // Outbox rows carry the project twice: the indexed column and the
      // queued action payload the engine sends.
      moved.outbox = await database.outbox
        .where("projectId")
        .equals(legacy)
        .modify((row) => {
          row.projectId = projectId;
          if (row.payload && row.payload.projectId === legacy) {
            row.payload = { ...row.payload, projectId };
          }
        });
    },
  );

  return moved;
}
