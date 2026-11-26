// src/seed/demoSeed.ts
//
// Wave 56 — first-boot demo seed: DIRECT Dexie injection of a curated,
// pre-parsed bundle (see SPEC-wave-56-demo-seed-and-mapping-filters.md).
//
// This REPLACES the Task 32 pipeline seed. That seed re-uploaded
// `/samples/*.ifc` through the full web-ifc → IfcImporter parse
// pipeline on every fresh profile — exactly what the maintainer does NOT
// want. Instead we inject the already-captured records + `.frag` /
// PDF blobs from `/seed/` straight into Dexie (`db` name `free-field`)
// with ZERO IFC reprocessing.
//
// Flow (spec §2):
//
//   1. Guard: demo mode only. Real mode never auto-seeds.
//   2. Guard: too many failures / a building already exists in the
//      demo project (the Dexie truth — wave 63; the localStorage flag
//      is no longer trusted, so a cleared IndexedDB re-seeds) → skip.
//   3. Fetch `/seed/manifest.json` and every referenced blob (in
//      parallel).
//   4. Inject the blobs (`fragBlobs` / `pdfBlobs`) and the data tables
//      (one parent-before-child `db.transaction("rw", ...)`) in order.
//   5. Set `ff-demo-seeded-v2` = "1" only after everything committed.
//
// The viewer picks the models up from `fragBlobs` via its normal load
// path (IfcViewer → useIfcFiles → getFragBlob → fragments.core.load) —
// no IFC parse worker ever runs on boot.

// The demo data lives under @ff/auth's DEMO_PROJECT_ID (wave 65: the one
// definition, aliasing LEGACY_DEFAULT_PROJECT_ID from @ff/types).
import { DEMO_PROJECT_ID, isDemoAuth } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { listBuildings } from "@ff/data/db/tables/buildings";

import type {
  ProjectRecord,
  BuildingRecord,
  IfcFileRecord,
  IfcVersionRecord,
  StoreyRecord,
  ExtractedStoreyRecord,
  BuildingLevelSelectionRecord,
  PdfFileRecord,
  PdfVersionRecord,
  PdfFolderRecord,
  PdfFolderAssignmentRecord,
  PropertyCatalogEntry,
  CalibrationRecord,
} from "@ff/types";

/** Outcome of one seed attempt. */
export type DemoSeedResult = "seeded" | "skipped" | "unavailable";

/**
 * LocalStorage flag — "1" once the pre-parsed demo data is in place.
 * Informational only since wave 63: "already seeded" is decided from
 * Dexie (a building in the demo project), never from this flag.
 */
export const SEEDED_STORAGE_KEY_V2 = "ff-demo-seeded-v2";

/** localStorage counter — how many seed attempts have failed. */
export const FAILED_STORAGE_KEY = "ff-demo-seed-failed";

/** After this many failures the seed gives up ("unavailable"). */
export const MAX_SEED_FAILURES = 3;

/**
 * The manifest's `tables` section — plain Dexie rows (Blob fields are
 * stripped out to the top-level `fragBlobs` / `pdfBlobs` arrays).
 */
interface SeedManifestTables {
  projects: ProjectRecord[];
  buildings: BuildingRecord[];
  ifcFiles: IfcFileRecord[];
  ifcVersions: IfcVersionRecord[];
  storeys: StoreyRecord[];
  extractedStoreys: ExtractedStoreyRecord[];
  buildingLevelSelection: BuildingLevelSelectionRecord[];
  pdfFiles: PdfFileRecord[];
  pdfVersions: PdfVersionRecord[];
  pdfFolders: PdfFolderRecord[];
  pdfFolderAssignments: PdfFolderAssignmentRecord[];
  propertyCatalog: PropertyCatalogEntry[];
  calibrations: CalibrationRecord[];
}

/** One `.frag` / PDF blob reference in the manifest. */
interface SeedBlobRef {
  key: string;
  __blob?: boolean;
}

/** Shape of `/seed/manifest.json`. */
interface SeedManifest {
  format: string;
  version: number;
  capturedAt?: string;
  note?: string;
  tables?: Partial<SeedManifestTables>;
  fragBlobs?: SeedBlobRef[];
  pdfBlobs?: SeedBlobRef[];
}

const EMPTY_TABLES: SeedManifestTables = {
  projects: [],
  buildings: [],
  ifcFiles: [],
  ifcVersions: [],
  storeys: [],
  extractedStoreys: [],
  buildingLevelSelection: [],
  pdfFiles: [],
  pdfVersions: [],
  pdfFolders: [],
  pdfFolderAssignments: [],
  propertyCatalog: [],
  calibrations: [],
};

// ── localStorage helpers (never throw — private mode kills them) ──

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable — the seed still works, it just re-runs */
  }
}

function removeStorage(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

function readFailureCount(): number {
  const raw = readStorage(FAILED_STORAGE_KEY);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function bumpFailureCount(): number {
  const next = readFailureCount() + 1;
  writeStorage(FAILED_STORAGE_KEY, String(next));
  return next;
}

// ── fetch helpers ──

/** Fetch the seed manifest and validate its envelope. */
/**
 * The repository ships without a demo bundle (`public/seed/` is
 * optional). A missing bundle is not a failure: the app simply starts
 * empty. Dev servers answer a missing file with the SPA's index.html,
 * so "not JSON" counts as missing too.
 */
class NoDemoBundle extends Error {}

async function fetchManifest(): Promise<SeedManifest> {
  const res = await fetch("/seed/manifest.json");
  if (res.status === 404) throw new NoDemoBundle();
  if (!res.ok) {
    throw new Error(`demo seed: manifest fetch failed (HTTP ${res.status})`);
  }
  const type = res.headers?.get?.("content-type") ?? "";
  if (type.includes("text/html")) throw new NoDemoBundle();
  const json = (await res.json()) as SeedManifest;
  // A wrong bundle would fail open here (types are only trusted from
  // the curated bundle), but the envelope check catches the cheap
  // mistake: a page accidentally routing us to a 404 HTML body.
  if (json && typeof json === "object" && json.format === "free-field-demo-seed") {
    return json;
  }
  throw new Error("demo seed: manifest is not a free-field-demo-seed bundle");
}

/**
 * Fetch every referenced blob in `refs`, returning `{ key, blob }`
 * pairs. All fetches complete (or throw) BEFORE anything is written
 * to Dexie, so a network shortfall leaves no half-seeded DB.
 */
async function fetchBlobs(
  refs: SeedBlobRef[],
  dir: "fragBlobs" | "pdfBlobs",
): Promise<Array<{ key: string; blob: Blob }>> {
  // In parallel: the bundle is a handful of multi-MB blobs, and a
  // serial chain made first boot wait for the sum of them.
  return Promise.all(
    refs.map(async (ref) => {
      const key = String(ref.key);
      const res = await fetch(`/seed/blobs/${dir}/${key}`);
      if (!res.ok) {
        throw new Error(
          `demo seed: blob fetch failed for ${dir}/${key} (HTTP ${res.status})`,
        );
      }
      return { key, blob: await res.blob() };
    }),
  );
}

/** Normalize the manifest tables to a fully-populated table set. */
function normalizeTables(
  tables: Partial<SeedManifestTables> | undefined,
): SeedManifestTables {
  if (!tables) return EMPTY_TABLES;
  const out = { ...EMPTY_TABLES };
  for (const key of Object.keys(out) as Array<keyof SeedManifestTables>) {
    const rows = tables[key];
    if (Array.isArray(rows)) {
      (out[key] as unknown[]) = rows;
    }
  }
  return out;
}

// ── injection ──

/**
 * Write every data table + blob into Dexie.
 *
 * Blobs first (idempotent `put`s), then the tables in ONE
 * parent-before-child `rw` transaction so a failure rolls the records
 * back atomically. Blob keys are referenced by `fragBlobKey` /
 * `blobKey` columns on the version rows, so parents-first matters for
 * a clean read-consistency story even though IndexedDB enforces no FK.
 */
async function injectSeed(
  tables: SeedManifestTables,
  fragBlobs: Array<{ key: string; blob: Blob }>,
  pdfBlobs: Array<{ key: string; blob: Blob }>,
): Promise<void> {
  for (const { key, blob } of fragBlobs) {
    await db.fragBlobs.put({ key, blob });
  }
  for (const { key, blob } of pdfBlobs) {
    await db.pdfBlobs.put({ key, bytes: blob });
  }

  await db.transaction(
    "rw",
    [
      db.projects,
      db.buildings,
      db.ifcFiles,
      db.pdfFiles,
      db.ifcVersions,
      db.pdfVersions,
      db.storeys,
      db.extractedStoreys,
      db.buildingLevelSelection,
      db.pdfFolders,
      db.pdfFolderAssignments,
      db.propertyCatalog,
      db.calibrations,
    ],
    async () => {
      await db.projects.bulkPut(tables.projects);
      await db.buildings.bulkPut(tables.buildings);
      await db.ifcFiles.bulkPut(tables.ifcFiles);
      await db.pdfFiles.bulkPut(tables.pdfFiles);
      await db.ifcVersions.bulkPut(tables.ifcVersions);
      await db.pdfVersions.bulkPut(tables.pdfVersions);
      await db.storeys.bulkPut(tables.storeys);
      await db.extractedStoreys.bulkPut(tables.extractedStoreys);
      await db.buildingLevelSelection.bulkPut(
        tables.buildingLevelSelection,
      );
      await db.pdfFolders.bulkPut(tables.pdfFolders);
      await db.pdfFolderAssignments.bulkPut(tables.pdfFolderAssignments);
      await db.propertyCatalog.bulkPut(tables.propertyCatalog);
      await db.calibrations.bulkPut(tables.calibrations);
    },
  );
}

// ── seeding status (drives the shell's "Loading demo…" state) ──

let seeding = false;
const statusListeners = new Set<() => void>();

function setSeeding(next: boolean): void {
  if (seeding === next) return;
  seeding = next;
  for (const l of [...statusListeners]) l();
}

/** True while the seed is fetching / writing the demo bundle. */
export function isDemoSeeding(): boolean {
  return seeding;
}

/** Subscribe to `isDemoSeeding()` changes (useSyncExternalStore shape). */
export function subscribeDemoSeeding(cb: () => void): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

// ── the seed itself ──

/**
 * In-flight seed. React StrictMode mounts effects twice in dev, and
 * the shell effect is fire-and-forget — without this guard the two
 * mounts could both pass the guards and seed twice.
 */
let inFlight: Promise<DemoSeedResult> | null = null;

/**
 * Seed the demo project by direct Dexie injection of the pre-parsed
 * `/seed/` bundle.
 *
 * Returns "seeded" when the demo data was created, "skipped" when
 * there was nothing to do (not demo mode / already seeded / a building
 * already exists) and "unavailable" when the seed failed (the app
 * still boots).
 */
/**
 * Top-up for profiles seeded before a seed PDF was added (e.g. the
 * plumbing v1/v2 revision pair for Compare). Adds only the seed PDF files
 * this browser lacks, for buildings it already has; never touches the
 * visitor's own data. Best effort: any failure leaves the DB unchanged
 * and does not count as a seed failure.
 */
async function topUpSeedPdfs(): Promise<DemoSeedResult> {
  try {
    const manifest = await fetchManifest();
    const tables = normalizeTables(manifest.tables);
    const haveFiles = new Set((await db.pdfFiles.toArray()).map((f) => f.id));
    const haveBuildings = new Set((await listBuildings(DEMO_PROJECT_ID)).map((b) => b.id));
    const files = tables.pdfFiles.filter(
      (f) => !haveFiles.has(f.id) && haveBuildings.has(f.buildingId),
    );
    if (files.length === 0) return "skipped";
    const fileIds = new Set(files.map((f) => f.id));
    const versions = tables.pdfVersions.filter((v) => fileIds.has(v.pdfFileId));
    const blobKeys = new Set(versions.map((v) => v.blobKey));
    const pdfBlobs = await fetchBlobs(
      (manifest.pdfBlobs ?? []).filter((r) => blobKeys.has(String(r.key))),
      "pdfBlobs",
    );
    const assignments = tables.pdfFolderAssignments.filter((a) => fileIds.has(a.pdfFileId));
    const folderIds = new Set(assignments.map((a) => a.folderId));
    const haveFolders = new Set((await db.pdfFolders.toArray()).map((f) => f.id));
    const folders = tables.pdfFolders.filter((f) => folderIds.has(f.id) && !haveFolders.has(f.id));
    for (const { key, blob } of pdfBlobs) {
      await db.pdfBlobs.put({ key, bytes: blob });
    }
    await db.transaction(
      "rw",
      [db.pdfFiles, db.pdfVersions, db.pdfFolders, db.pdfFolderAssignments],
      async () => {
        await db.pdfFolders.bulkPut(folders);
        await db.pdfFiles.bulkPut(files);
        await db.pdfVersions.bulkPut(versions);
        await db.pdfFolderAssignments.bulkPut(assignments);
      },
    );
    return "seeded";
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[demoSeed] seed PDF top-up skipped:", err);
    return "skipped";
  }
}

export function runDemoSeedIfEmpty(): Promise<DemoSeedResult> {
  if (!inFlight) {
    inFlight = runSeed();
  }
  return inFlight;
}

async function runSeed(): Promise<DemoSeedResult> {
  // Guard 1 — real mode never auto-seeds.
  if (!isDemoAuth()) return "skipped";

  // Guard 3 — a broken seed must not loop forever.
  if (readFailureCount() >= MAX_SEED_FAILURES) return "unavailable";

  // Guard 2 — already seeded, decided from Dexie: a building already
  // exists in the demo project (also protects profiles populated by
  // the old pipeline seed or by the boss's own work).
  const existing = await listBuildings(DEMO_PROJECT_ID);
  if (existing.length > 0) return topUpSeedPdfs();

  setSeeding(true);
  try {
    const manifest = await fetchManifest();
    const tables = normalizeTables(manifest.tables);
    // Fetch the blobs BEFORE writing anything: a network failure here
    // must leave the DB untouched (and thus retryable next boot).
    const fragBlobs = await fetchBlobs(manifest.fragBlobs ?? [], "fragBlobs");
    const pdfBlobs = await fetchBlobs(manifest.pdfBlobs ?? [], "pdfBlobs");

    await injectSeed(tables, fragBlobs, pdfBlobs);

    // Remember the seed so a reload never re-seeds.
    writeStorage(SEEDED_STORAGE_KEY_V2, "1");
    removeStorage(FAILED_STORAGE_KEY);
    return "seeded";
  } catch (err) {
    if (err instanceof NoDemoBundle) return "skipped";
    bumpFailureCount();
    // eslint-disable-next-line no-console
    console.warn("[demoSeed] demo seed failed:", err);
    return "unavailable";
  } finally {
    setSeeding(false);
  }
}