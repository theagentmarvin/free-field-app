// __tests__/db/lifecycle.test.ts — Dexie resilience (wave 63 review item 8).
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  db,
  DATABASE_NAME,
  onDatabaseLifecycle,
  requestPersistentStorage,
  __resetPersistRequestForTests,
  type DatabaseLifecycleEvent,
} from "../../src/db/database";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPersistRequestForTests();
});

describe("persistent storage", () => {
  it("asks navigator.storage.persist() once", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist, persisted: async () => false } });
    expect(await requestPersistentStorage()).toBe(true);
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });
  it("resolves false without the API", async () => {
    vi.stubGlobal("navigator", {});
    expect(await requestPersistentStorage()).toBe(false);
  });
});

describe("versionchange", () => {
  it("a newer schema in another connection closes ours and emits versionchange", async () => {
    await db.open();
    const events: DatabaseLifecycleEvent[] = [];
    const off = onDatabaseLifecycle((e) => events.push(e));
    const newer = new Dexie(DATABASE_NAME);
    newer.version(db.verno + 1).stores({ probe: "&id" });
    await newer.open(); // would hang ("blocked") if we kept our connection open
    expect(db.isOpen()).toBe(false);
    expect(events[0]).toMatchObject({ type: "versionchange" });
    off();
    newer.close();
  });
});
