import { afterEach, describe, expect, it } from "vitest";
import type { PlanMarkupRecord } from "@ff/types";

import type { SyncEngine } from "../src";
import { FakeBucket, FakeServer, makeEngine, waitFor } from "./fakes";

const P = "proj-1";
let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
});

async function setup(canWrite: boolean, uid = "alice") {
  const server = new FakeServer();
  const bucket = new FakeBucket();
  const h = makeEngine(server, bucket, { uid });
  engines.push(h.engine);
  await h.engine.start(P, { canWrite });
  return { server, bucket, ...h };
}

const markup = (id: string, over: Partial<PlanMarkupRecord> = {}): PlanMarkupRecord => ({
  id, projectId: P, pdfFileId: "pf1", pdfVersionId: "pv1", page: 1, kind: "arrow", color: "#d94141",
  strokeWidth: 0.003, shape: JSON.stringify({ pts: [[0.1, 0.1], [0.4, 0.3]] }), bbox: [0.1, 0.1, 0.4, 0.3],
  taskId: null, createdBy: "alice", createdAt: 1000, ...over,
});
const key = (id: string) => `${P}/planMarkups/${id}`;

describe("plan markups sync", () => {
  it("a read-only MEMBER's markup is enqueued, drained and echoed (remoteUpdatedAt set)", async () => {
    const { server, db } = await setup(false);
    await db.planMarkups.add(markup("m1"));
    await waitFor(() => server.docs.has(key("m1")));
    expect(server.docs.get(key("m1"))!.data).toMatchObject({ kind: "arrow", createdBy: "alice", pdfVersionId: "pv1" });
    await waitFor(async () => !!(await db.planMarkups.get("m1"))!.remoteUpdatedAt);
  });

  it("an admin's markup syncs even before the first-upload decision", async () => {
    const server = new FakeServer();
    const h = makeEngine(server, new FakeBucket(), { uid: "root" });
    engines.push(h.engine);
    const db = h.db;
    // A local-only building makes the engine arm the first-upload prompt ("pending").
    await db.buildings.add({ id: "b1", projectId: P, name: "T", metadata: {}, createdAt: 1, updatedAt: 1 });
    await h.engine.start(P, { canWrite: true });
    await db.planMarkups.add(markup("m1", { createdBy: "root" }));
    await waitFor(() => server.docs.has(key("m1")));
    // the local-only building is still held back by the publish prompt
    expect(server.docs.has(`${P}/buildings/b1`)).toBe(false);
  });

  it("offline create, edit and delete coalesce; reconnect sends one create then a tombstone", async () => {
    const { server, db, online, engine } = await setup(false);
    online.value = false;
    await db.planMarkups.add(markup("m1"));
    await db.planMarkups.update("m1", { bbox: [0.2, 0.2, 0.5, 0.4] });
    await db.planMarkups.add(markup("m2", { kind: "pen" }));
    await waitFor(async () => (await db.outbox.count()) >= 2);
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => server.docs.has(key("m1")) && server.docs.has(key("m2")));
    expect(server.docs.get(key("m1"))!.data.bbox).toEqual([0.2, 0.2, 0.5, 0.4]);
    expect(server.writes.filter((w) => w.key === "planMarkups/m1")).toHaveLength(1);

    online.value = false;
    await db.planMarkups.delete("m2");
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => server.docs.get(key("m2"))!.deleted);
    expect(server.docs.get(key("m1"))!.deleted).toBe(false);
  });

  it("a member does NOT enqueue rows of admin-only tables", async () => {
    const { server, db } = await setup(false);
    await db.buildings.add({ id: "b1", projectId: P, name: "T", metadata: {}, createdAt: 1, updatedAt: 1 });
    await db.planMarkups.add(markup("m1"));
    await waitFor(() => server.docs.has(key("m1")));
    expect(await db.outbox.where("kind").equals("doc-upsert").count()).toBe(1);
    expect(server.docs.has(`${P}/buildings/b1`)).toBe(false);
  });

  it("a member never drains a queued admin-only row (left for an admin session)", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    const h = makeEngine(server, bucket);
    engines.push(h.engine);
    await h.engine.start(P, { canWrite: true });
    h.online.value = false;
    await h.db.buildings.add({ id: "b1", projectId: P, name: "T", metadata: {}, createdAt: 1, updatedAt: 1 });
    await h.engine.publishLocal();
    await waitFor(async () => (await h.db.outbox.count()) >= 1);
    h.online.value = true;
    await h.engine.start(P, { canWrite: false });
    await new Promise((r) => setTimeout(r, 120));
    expect(server.docs.has(`${P}/buildings/b1`)).toBe(false);
  });

  it("another device's markup and its tombstone arrive through down-sync (all roles)", async () => {
    const { server, db } = await setup(false, "bob");
    server.put(P, "planMarkups", "r1", { ...markup("r1", { createdBy: "alice" }) });
    await waitFor(async () => !!(await db.planMarkups.get("r1")));
    expect((await db.planMarkups.get("r1"))!.createdBy).toBe("alice");
    server.put(P, "planMarkups", "r1", { ...markup("r1") }, true);
    await waitFor(async () => !(await db.planMarkups.get("r1")));
  });

  it("a remote doc applied locally is not echoed back as a write", async () => {
    const { server, db } = await setup(false, "bob");
    server.put(P, "planMarkups", "r1", { ...markup("r1") });
    await waitFor(async () => !!(await db.planMarkups.get("r1")));
    await new Promise((r) => setTimeout(r, 80));
    expect(server.writes).toHaveLength(0);
  });
});
