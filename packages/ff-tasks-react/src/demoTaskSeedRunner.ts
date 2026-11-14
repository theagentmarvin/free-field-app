import { DEMO_PROJECT_ID, isDemoAuth } from "@ff/auth";
import {
  listBuildings,
  listIfcFiles,
  listPdfFiles,
  listStoreys,
} from "@ff/data";
import {
  buildDemoTaskSeeds,
  getDemoTaskSource,
} from "@ff/tasks";

/**
 * Demo task seed — runs AFTER the building/IFC/PDF seed has landed (the
 * shell chains it off `runDemoSeedIfEmpty`), reads the REAL demo model/
 * storey/pdf ids out of Dexie, and seeds 6–8 realistic tasks into the
 * Dexie-backed demo task store. Idempotent via `DemoTaskSource.seed`
 * (a no-op when the store already has rows), so reloads and StrictMode
 * double-mounts never duplicate.
 */

let inFlight: Promise<"seeded" | "skipped"> | null = null;

/** Guarded — demo mode only, and only when the demo building exists. */
export function runDemoTasksSeedIfEmpty(): Promise<"seeded" | "skipped"> {
  if (!inFlight) {
    inFlight = seed();
  }
  return inFlight;
}

async function seed(): Promise<"seeded" | "skipped"> {
  if (!isDemoAuth()) return "skipped";

  const buildings = await listBuildings(DEMO_PROJECT_ID);
  if (buildings.length === 0) return "skipped";
  const buildingId = buildings[0].id;

  const ifcFiles = await listIfcFiles(buildingId);
  const pdfFiles = await listPdfFiles(buildingId);
  if (ifcFiles.length === 0 || pdfFiles.length === 0) return "skipped";

  const storeyRows = await listStoreys(buildingId);
  const storeys = storeyRows
    .map((s) => ({
      name: s.name,
      elevation: s.elevation,
      expressId: s.expressId,
      containedElementIds: s.containedElementIds,
    }))
    .sort((a, b) => a.elevation - b.elevation);

  const source = getDemoTaskSource();
  const seeded = await source.seed(
    DEMO_PROJECT_ID,
    buildDemoTaskSeeds({
      projectId: DEMO_PROJECT_ID,
      modelId: ifcFiles[0].id,
      storeys,
      pdfFileId: pdfFiles[0].id,
    }),
  );

  return seeded ? "seeded" : "skipped";
}