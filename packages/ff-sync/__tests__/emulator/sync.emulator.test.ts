// @vitest-environment node
/**
 * Phase 1c/1d integration: two clients (own Dexie + own Firestore/Storage SDK
 * instance, own uid) run the real engine against the Firebase emulators with
 * the real firestore.rules / storage.rules.
 */

import {
  initializeTestEnvironment,
  assertFails,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { disableNetwork, doc, enableNetwork, setDoc } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fragStoragePath } from "@ff/firestore";
import type { ProjectDatabase } from "@ff/data/db/database";

import { createSyncEngine, type SyncEngine } from "../../src";
import { createFirestoreRemote, createStorageTransport } from "../../src/firebase";
import { bytes, freshDb, sha, waitFor } from "../fakes";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const PID = "p1";

let env: RulesTestEnvironment;
beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-freefield",
    firestore: { rules: readFileSync(join(root, "packages/ff-firestore/firestore.rules"), "utf8") },
    storage: { rules: readFileSync(join(root, "storage.rules"), "utf8") },
  });
});
afterAll(async () => {
  await env.cleanup();
});

interface Client {
  uid: string;
  db: ProjectDatabase;
  engine: SyncEngine;
  online: { value: boolean };
  fs: ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["firestore"]>;
  storage: ReturnType<ReturnType<RulesTestEnvironment["authenticatedContext"]>["storage"]>;
}
let clients: Client[] = [];

async function seedMember(uid: string, role: "admin" | "member"): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `projects/${PID}/members/${uid}`), {
      uid, role, status: "active", joinedAt: new Date(), invitedBy: "seed",
    });
  });
}

async function client(uid: string, role: "admin" | "member" = "admin"): Promise<Client> {
  await seedMember(uid, role);
  const ctx = env.authenticatedContext(uid);
  const fs = ctx.firestore();
  const storage = ctx.storage();
  const db = freshDb();
  const online = { value: true };
  const engine = createSyncEngine({
    db,
    remote: createFirestoreRemote(fs as never),
    transport: createStorageTransport(storage as never),
    uid,
    isOnline: () => online.value,
  });
  if (process.env.SYNC_DEBUG) engine.subscribe((e) => (e.type === "down-error" || e.type === "blob-error") && console.log(uid, JSON.stringify(e)));
  const c: Client = { uid, db, engine, online, fs, storage };
  clients.push(c);
  await engine.start(PID, { canWrite: role === "admin" });
  return c;
}

async function goOffline(c: Client): Promise<void> {
  c.online.value = false;
  await disableNetwork(c.fs as never);
}
async function goOnline(c: Client): Promise<void> {
  await enableNetwork(c.fs as never);
  c.online.value = true;
  await c.engine.notifyOnline();
}

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
});
afterEach(async () => {
  if (process.env.SYNC_DEBUG) {
    for (const c of clients) {
      const rows = await c.db.outbox.toArray();
      console.log(c.uid, JSON.stringify(rows.map((r) => [r.kind, r.state, r.lastError])));
    }
  }
  for (const c of clients) c.engine.dispose();
  clients = [];
});

const building = (id: string, name: string) => ({ id, projectId: PID, name, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
const pt = { pdfX: 1, pdfY: 2, worldX: 3, worldZ: 4 };
const calib = (id: string, scale: number) => ({
  id, projectId: PID, pdfFileId: "d1", storeyName: "Level 1", pointPairs: [pt, pt] as [typeof pt, typeof pt],
  transformParams: { scale, rotation: 0, translateX: 0, translateZ: 0 }, confidence: 1, createdAt: Date.now(), updatedAt: Date.now(),
});

// The Firestore node SDK occasionally loses a Listen stream against the
// emulator ("RESOURCE_EXHAUSTED: Received message larger than max" with a
// garbage frame length) and then backs off for up to a minute. That is an
// SDK/emulator transport flake, not engine behaviour, so each test may retry.
describe("emulator: two clients on one project", { retry: 2, timeout: 60_000 }, () => {
  it("converge online (create, rename, delete)", async () => {
    const a = await client("admin-a");
    const b = await client("admin-b");
    await a.db.buildings.add(building("b1", "Tower"));
    await waitFor(async () => (await b.db.buildings.get("b1"))?.name === "Tower");
    await b.db.buildings.update("b1", { name: "Tower B" });
    await waitFor(async () => (await a.db.buildings.get("b1"))?.name === "Tower B");
    await a.db.buildings.delete("b1");
    await waitFor(async () => !(await b.db.buildings.get("b1")));
  });

  it("members read but cannot write (rules deny; row fails, nothing leaks)", async () => {
    const a = await client("admin-a");
    const m = await client("member-m", "member");
    await a.db.buildings.add(building("b1", "Tower"));
    await waitFor(async () => !!(await m.db.buildings.get("b1")));
    // a member never enqueues
    await m.db.buildings.add(building("b2", "Sneaky"));
    await new Promise((r) => setTimeout(r, 300));
    expect(await m.db.outbox.count()).toBe(0);
  });

  it("offline edits on both converge on reconnect (last server write wins)", async () => {
    const a = await client("admin-a");
    const b = await client("admin-b");
    await a.db.buildings.add(building("b1", "Tower"));
    await waitFor(async () => !!(await b.db.buildings.get("b1")));
    await goOffline(a);
    await goOffline(b);
    await a.db.buildings.update("b1", { name: "From A" });
    await b.db.buildings.update("b1", { name: "From B" });
    await b.db.buildings.add(building("b2", "Only B"));
    await a.db.buildings.add(building("b3", "Only A"));
    await goOnline(a); // A reconnects first ...
    await waitFor(async () => (await a.db.outbox.where("state").equals("sent").count()) >= 2);
    await goOnline(b); // ... B later: B's write is the later server write
    await waitFor(async () => (await b.db.outbox.where("state").equals("sent").count()) >= 2);
    for (const c of [a, b]) {
      await waitFor(async () => (await c.db.buildings.get("b1"))?.name === "From B" && !!(await c.db.buildings.get("b2")) && !!(await c.db.buildings.get("b3")));
    }
    expect((await a.db.buildings.toArray()).map((x) => x.name).sort()).toEqual((await b.db.buildings.toArray()).map((x) => x.name).sort());
  });

  it("calibration of the same pair converges to ONE doc", async () => {
    const a = await client("admin-a");
    const b = await client("admin-b");
    await goOffline(a);
    await goOffline(b);
    await a.db.calibrations.add(calib("uuid-a", 1));
    await b.db.calibrations.add(calib("uuid-b", 2));
    await goOnline(a);
    await waitFor(async () => (await a.db.outbox.where("state").equals("sent").count()) >= 1);
    await goOnline(b);
    await waitFor(async () => (await b.db.outbox.where("state").equals("sent").count()) >= 1);
    // one server doc
    let snap: string[] = [];
    await env.withSecurityRulesDisabled(async (ctx) => {
      const { getDocs, collection } = await import("firebase/firestore");
      snap = (await getDocs(collection(ctx.firestore(), `projects/${PID}/calibrations`))).docs.map((d) => d.id);
    });
    expect(snap).toEqual(["d1__Level%201"]);
    for (const c of [a, b]) {
      await waitFor(async () => (await c.db.calibrations.toArray()).every((r) => r.transformParams.scale === 2));
      expect(await c.db.calibrations.count()).toBe(1);
    }
  });

  it("a second client downloads a .frag uploaded by the first and verifies sha256; overwrite is denied", async () => {
    const a = await client("admin-a");
    const b = await client("member-b", "member");
    const frag = bytes(4096, 42);
    await a.db.buildings.add(building("b1", "Tower"));
    await a.db.transaction("rw", [a.db.ifcFiles, a.db.ifcVersions, a.db.fragBlobs], async () => {
      await a.db.fragBlobs.put({ key: "i1__v1", blob: frag });
      await a.db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: Date.now(), updatedAt: Date.now() });
      await a.db.ifcVersions.add({ id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 9, contentHash: "h", fragBlobKey: "i1__v1", storeyCount: 0, createdAt: Date.now(), isLatest: true });
    });
    await waitFor(async () => !!(await b.db.ifcVersions.get("v1"))?.fragSha256, 15000);
    const row = (await b.db.ifcVersions.get("v1"))!;
    expect(row.fragStoragePath).toBe(fragStoragePath(PID, "v1"));
    expect(row.fragSha256).toBe(await sha(frag));
    expect(row.fragSizeBytes).toBe(4096);

    const r = await b.engine.downloadBuilding("b1");
    expect(r).toMatchObject({ downloaded: 1, failed: [] });
    expect(await sha((await b.db.fragBlobs.get("i1__v1"))!.blob)).toBe(await sha(frag));

    // Immutable: nobody (not even the admin who wrote it) can overwrite.
    await assertFails(uploadBytes(ref(a.storage as never, fragStoragePath(PID, "v1")), new Uint8Array([1, 2, 3]), { contentType: "application/octet-stream" }));
  });

  it("first-upload publish moves local-only rows (with blobs) to the project", async () => {
    // Local data exists BEFORE the engine starts (re-keyed legacy rows).
    await seedMember("admin-a", "admin");
    const ctx = env.authenticatedContext("admin-a");
    const db = freshDb();
    await db.buildings.add(building("b1", "Local tower"));
    await db.fragBlobs.put({ key: "k", blob: bytes(512, 9) });
    await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v-pub", createdAt: 1, updatedAt: 1 });
    await db.ifcVersions.add({ id: "v-pub", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k", storeyCount: 0, createdAt: 1, isLatest: true });
    const engine = createSyncEngine({ db, remote: createFirestoreRemote(ctx.firestore() as never), transport: createStorageTransport(ctx.storage() as never), uid: "admin-a" });
    clients.push({ uid: "admin-a", db, engine, online: { value: true }, fs: ctx.firestore() as never, storage: ctx.storage() as never });
    await engine.start(PID, { canWrite: true });
    expect(await engine.getPublishInfo()).toMatchObject({ state: "pending", buildings: 1 });
    await engine.publishLocal();
    await waitFor(async () => !!(await db.ifcVersions.get("v-pub"))?.remoteUpdatedAt && !!(await db.buildings.get("b1"))?.remoteUpdatedAt, 15000);
    const b = await client("admin-b");
    await waitFor(async () => !!(await b.db.ifcVersions.get("v-pub")), 15000);
    expect(await b.engine.downloadBuilding("b1")).toMatchObject({ downloaded: 1 });
  });
});
