// __tests__/db/helpers.ts
//
// Test helpers: a single fake-indexeddb-backed Dexie instance shared
// across the test run, with `clear()` invoked in `beforeEach` so tests
// start from an empty schema.

import { db } from "@ff/data/db/database";

/**
 * Ensure the test database is open and empty. Call this at the top of
 * every `beforeEach` (or at the start of each test) so prior state
 * cannot leak between tests.
 */
export async function resetDb(_testId?: string): Promise<void> {
  if (!db.isOpen()) {
    await db.open();
  }
  await clearAllTables();
}

/** Clear all rows in all tables without closing the connection. */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.projects,
      db.buildings,
      db.ifcFiles,
      db.ifcVersions,
      db.storeys,
      db.extractedStoreys,
      db.fragBlobs,
      db.buildingLevelSelection,
      db.pdfFiles,
      db.pdfVersions,
      db.pdfBlobs,
      db.calibrations,
      db.propertyCatalog,
      db.filterPresets,
      db.pdfFolders,
      db.pdfFolderAssignments,
    ],
    async () => {
      await db.projects.clear();
      await db.buildings.clear();
      await db.ifcFiles.clear();
      await db.ifcVersions.clear();
      await db.storeys.clear();
      await db.extractedStoreys.clear();
      await db.fragBlobs.clear();
      await db.buildingLevelSelection.clear();
      await db.pdfFiles.clear();
      await db.pdfVersions.clear();
      await db.pdfBlobs.clear();
      await db.calibrations.clear();
      await db.propertyCatalog.clear();
      await db.filterPresets.clear();
      await db.pdfFolders.clear();
      await db.pdfFolderAssignments.clear();
    },
  );
}
