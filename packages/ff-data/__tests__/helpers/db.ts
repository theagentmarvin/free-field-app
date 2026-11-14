// __tests__/helpers/db.ts — open the shared (fake-indexeddb) Dexie and
// empty every table between tests.
import { db } from "../../src/db/database";

export async function resetDb(): Promise<void> {
  if (!db.isOpen()) await db.open();
  await db.transaction("rw", db.tables, async () => {
    for (const t of db.tables) await t.clear();
  });
}
