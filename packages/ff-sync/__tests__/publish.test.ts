import { afterEach, describe, expect, it } from "vitest";

import type { SyncEngine, SyncEvent } from "../src";
import { FakeBucket, FakeServer, bytes, makeEngine, waitFor } from "./fakes";

const P = "proj-1";
let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
});

async function seedLocal(db: any) {
  const now = Date.now();
  await db.buildings.add({ id: "b1", projectId: P, name: "Tower", metadata: {}, createdAt: 1, updatedAt: 1 });
  await db.fragBlobs.put({ key: "k", blob: bytes(10) });
  await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: 1, updatedAt: 1 });
  await db.ifcVersions.add({ id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k", storeyCount: 1, createdAt: 1, isLatest: true });
  await db.storeys.add({ id: "s1", buildingId: "b1", ifcVersionId: "v1", sourceIfcFileId: "i1", name: "L1", elevation: 0, expressId: 1, height: null, containedElementIds: [] });
  void now;
}

describe("first-upload prompt", () => {
  it("local-only buildings => prompt event, nothing is uploaded until accepted", async () => {
    const server = new FakeServer();
    const { engine, db } = makeEngine(server, new FakeBucket());
    engines.push(engine);
    await seedLocal(db);
    const events: SyncEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start(P, { canWrite: true });
    expect(events.find((e) => e.type === "publish-available")).toMatchObject({ buildings: 1 });
    await new Promise((r) => setTimeout(r, 60));
    expect(server.docs.size).toBe(0);
    expect(await db.outbox.count()).toBe(0);
    expect(await engine.getPublishInfo()).toMatchObject({ state: "pending", buildings: 1 });

    // edits while undecided are not published
    await db.buildings.update("b1", { name: "Tower 2" });
    await new Promise((r) => setTimeout(r, 30));
    expect(await db.outbox.count()).toBe(0);

    await engine.publishLocal();
    await waitFor(() => server.docs.size === 4);
    expect([...server.docs.keys()].sort()).toEqual([
      `${P}/buildings/b1`, `${P}/ifcFiles/i1`, `${P}/ifcVersions/v1`, `${P}/storeys/s1`,
    ]);
    expect(server.docs.get(`${P}/buildings/b1`)!.data.name).toBe("Tower 2");
    // parents before children
    expect(server.writes.map((w) => w.key)).toEqual(["buildings/b1", "ifcFiles/i1", "ifcVersions/v1", "storeys/s1"]);
    expect((await engine.getPublishInfo())!.state).toBe("published");
  });

  it("decline keeps old rows local but new work still syncs", async () => {
    const server = new FakeServer();
    const { engine, db } = makeEngine(server, new FakeBucket());
    engines.push(engine);
    await seedLocal(db);
    await engine.start(P, { canWrite: true });
    await engine.declinePublish();
    await db.buildings.update("b1", { name: "renamed" }); // old local-only row: stays local
    await db.buildings.add({ id: "b2", projectId: P, name: "New", metadata: {}, createdAt: Date.now() + 1000, updatedAt: Date.now() });
    await waitFor(() => server.docs.has(`${P}/buildings/b2`));
    expect(server.docs.has(`${P}/buildings/b1`)).toBe(false);
  });

  it("no local buildings => no prompt, state published", async () => {
    const server = new FakeServer();
    const { engine } = makeEngine(server, new FakeBucket());
    engines.push(engine);
    const events: SyncEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start(P, { canWrite: true });
    expect(events.some((e) => e.type === "publish-available")).toBe(false);
    expect((await engine.getPublishInfo())!.state).toBe("published");
  });

  it("members never get the prompt", async () => {
    const server = new FakeServer();
    const { engine, db } = makeEngine(server, new FakeBucket());
    engines.push(engine);
    await seedLocal(db);
    const events: SyncEvent[] = [];
    engine.subscribe((e) => events.push(e));
    await engine.start(P, { canWrite: false });
    expect(events.some((e) => e.type === "publish-available")).toBe(false);
  });
});
