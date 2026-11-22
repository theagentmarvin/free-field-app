import { afterEach, describe, expect, it } from "vitest";

import type { SyncEngine } from "../src";
import { FakeBucket, FakeServer, makeEngine, waitFor } from "./fakes";

const P = "proj-1";
const bdoc = (id: string, name: string) => ({ id, projectId: P, name, metadata: {}, createdAt: 1 });

let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
});

async function setup(canWrite = false) {
  const server = new FakeServer();
  const h = makeEngine(server, new FakeBucket());
  engines.push(h.engine);
  return { server, ...h, start: () => h.engine.start(P, { canWrite }) };
}

describe("down-sync", () => {
  it("applies remote docs into Dexie with remoteUpdatedAt, without enqueueing", async () => {
    const { server, db, start } = await setup(true);
    server.put(P, "buildings", "b1", bdoc("b1", "Tower"));
    await start();
    await waitFor(async () => !!(await db.buildings.get("b1")));
    const row = await db.buildings.get("b1");
    expect(row).toMatchObject({ name: "Tower", projectId: P, remoteUpdatedAt: server.docs.get(`${P}/buildings/b1`)!.updatedAtMs });
    expect(await db.outbox.count()).toBe(0);
    expect(server.writes).toHaveLength(0);
  });

  it("a tombstone deletes the local row", async () => {
    const { server, db, engine, start } = await setup();
    server.put(P, "buildings", "b1", bdoc("b1", "Tower"));
    await start();
    await waitFor(async () => !!(await db.buildings.get("b1")));
    server.put(P, "buildings", "b1", bdoc("b1", "Tower"), true);
    await waitFor(async () => !(await db.buildings.get("b1")));
    await engine.idle();
  });

  it("tombstoned version deletes its local blob too", async () => {
    const { server, db, start } = await setup();
    await db.fragBlobs.put({ key: "k1", blob: new Blob(["x"]) });
    server.put(P, "ifcVersions", "v1", {
      id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k1", storeyCount: 0,
      createdAt: 1, isLatest: true, storagePath: null, sha256: null, sizeBytes: null, contentType: null,
      fragStoragePath: null, fragSha256: null, fragSizeBytes: null,
    });
    await start();
    await waitFor(async () => !!(await db.ifcVersions.get("v1")));
    server.put(P, "ifcVersions", "v1", (await db.ifcVersions.get("v1")) as never, true);
    await waitFor(async () => !(await db.ifcVersions.get("v1")));
    expect(await db.fragBlobs.get("k1")).toBeUndefined();
  });

  it("skips overwriting a row with a pending outbox record, then converges on the server echo", async () => {
    const { server, db, online, engine, start } = await setup(true);
    server.put(P, "buildings", "b1", bdoc("b1", "Tower"));
    await start();
    await waitFor(async () => !!(await db.buildings.get("b1")));
    online.value = false; // keep the local edit queued
    await db.buildings.update("b1", { name: "Local edit" });
    await waitFor(async () => (await db.outbox.count()) > 0);
    server.put(P, "buildings", "b1", bdoc("b1", "Remote edit"));
    await engine.idle();
    await new Promise((r) => setTimeout(r, 30));
    expect((await db.buildings.get("b1"))!.name).toBe("Local edit");
    // Back online: the local write lands later => LWW => local wins everywhere.
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => (server.docs.get(`${P}/buildings/b1`)!.data.name as string) === "Local edit");
    await waitFor(async () => (await db.outbox.where("state").equals("sent").count()) > 0);
    expect((await db.buildings.get("b1"))!.name).toBe("Local edit");
  });

  it("persists a cursor per project+collection and resumes after it", async () => {
    const { server, db, engine, start } = await setup();
    server.put(P, "buildings", "b1", bdoc("b1", "One"));
    await start();
    await waitFor(async () => !!(await db.buildings.get("b1")));
    const cur = (await db.syncState.get(`cursor:${P}:buildings`))!.cursorMs!;
    expect(cur).toBe(server.docs.get(`${P}/buildings/b1`)!.updatedAtMs);
    engine.stop();
    // Local row wiped; a restart only receives newer docs.
    await db.buildings.clear();
    server.put(P, "buildings", "b2", bdoc("b2", "Two"));
    await engine.start(P, { canWrite: false });
    await waitFor(async () => !!(await db.buildings.get("b2")));
    expect(await db.buildings.get("b1")).toBeUndefined();
  });

  it("stop() ends the listeners; start(other project) switches", async () => {
    const { server, db, engine, start } = await setup();
    await start();
    engine.stop();
    server.put(P, "buildings", "b9", bdoc("b9", "Late"));
    await new Promise((r) => setTimeout(r, 40));
    expect(await db.buildings.get("b9")).toBeUndefined();
    await engine.start("proj-2", { canWrite: false });
    expect(engine.projectId).toBe("proj-2");
  });

  it("duplicate building names from two devices both survive (incoming renamed)", async () => {
    const { server, db, start } = await setup();
    await db.buildings.add({ id: "mine", projectId: P, name: "Tower", metadata: {}, createdAt: 1, updatedAt: 1 });
    server.put(P, "buildings", "theirs", bdoc("theirs", "Tower"));
    await start();
    await waitFor(async () => !!(await db.buildings.get("theirs")));
    expect((await db.buildings.get("theirs"))!.name).toBe("Tower (2)");
    expect((await db.buildings.get("mine"))!.name).toBe("Tower");
  });

  it("invalid docs are skipped, not applied", async () => {
    const { server, db, engine, start } = await setup();
    const events: string[] = [];
    engine.subscribe((e) => e.type === "down-applied" && events.push(`${e.collection}:${e.skippedInvalid}`));
    server.put(P, "buildings", "bad", { id: "bad", projectId: P });
    await start();
    await waitFor(() => events.length > 0);
    expect(await db.buildings.get("bad")).toBeUndefined();
    expect(events).toContain("buildings:1");
  });

  it("calibration of the same pair maps onto the existing local row (one row)", async () => {
    const { server, db, start } = await setup();
    const pt = { pdfX: 1, pdfY: 2, worldX: 3, worldZ: 4 };
    await db.calibrations.add({
      id: "local-uuid", projectId: P, pdfFileId: "d1", storeyName: "L1", pointPairs: [pt, pt],
      transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 }, confidence: 1, createdAt: 1, updatedAt: 1,
    });
    server.put(P, "calibrations", "d1__L1", {
      id: "d1__L1", projectId: P, pdfFileId: "d1", storeyName: "L1", pointPairs: [pt, pt],
      transformParams: { scale: 9, rotation: 0, translateX: 0, translateZ: 0 }, confidence: 1, createdAt: 2,
    });
    await start();
    await waitFor(async () => (await db.calibrations.get("local-uuid"))?.transformParams.scale === 9);
    expect(await db.calibrations.count()).toBe(1);
  });
});
