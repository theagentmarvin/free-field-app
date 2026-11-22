import { afterEach, describe, expect, it } from "vitest";
import { fragStoragePath, pdfStoragePath } from "@ff/firestore";

import type { SyncEngine } from "../src";
import { FakeBucket, FakeServer, bytes, makeEngine, sha, waitFor } from "./fakes";

const P = "proj-1";
let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
});

async function setup(canWrite = true) {
  const server = new FakeServer();
  const bucket = new FakeBucket();
  const h = makeEngine(server, bucket);
  engines.push(h.engine);
  await h.engine.start(P, { canWrite });
  return { server, bucket, ...h };
}
const building = (id: string, name = "Tower") => ({ id, projectId: P, name, metadata: {}, createdAt: Date.now(), updatedAt: Date.now() });
const sent = async (db: any, n: number) => (await db.outbox.where("state").equals("sent").count()) >= n;

describe("up-sync", () => {
  it("a local building write becomes a doc upsert; echo sets remoteUpdatedAt", async () => {
    const { server, db } = await setup();
    await db.buildings.add(building("b1"));
    await waitFor(() => server.docs.has(`${P}/buildings/b1`));
    expect(server.docs.get(`${P}/buildings/b1`)!.data).toMatchObject({ name: "Tower", projectId: P });
    await waitFor(async () => !!(await db.buildings.get("b1"))!.remoteUpdatedAt);
  });

  it("a burst of edits to one doc is coalesced and writes the latest row", async () => {
    const { server, db, online, engine } = await setup();
    online.value = false;
    await db.buildings.add(building("b1", "v0"));
    await db.buildings.update("b1", { name: "v1" });
    await db.buildings.update("b1", { name: "v2" });
    await waitFor(async () => (await db.outbox.count()) >= 1);
    expect(await db.outbox.count()).toBe(1);
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => server.docs.has(`${P}/buildings/b1`));
    expect(server.docs.get(`${P}/buildings/b1`)!.data.name).toBe("v2");
    expect(server.writes.filter((w) => w.key === "buildings/b1")).toHaveLength(1);
  });

  it("delete enqueues a tombstone (never a hard delete)", async () => {
    const { server, db } = await setup();
    await db.buildings.add(building("b1"));
    await waitFor(async () => !!(await db.buildings.get("b1"))!.remoteUpdatedAt);
    await db.buildings.delete("b1");
    await waitFor(() => server.docs.get(`${P}/buildings/b1`)!.deleted);
    expect(server.docs.has(`${P}/buildings/b1`)).toBe(true);
  });

  it("a delete of a never-synced doc is a no-op on the server", async () => {
    const { server, db, online } = await setup();
    online.value = false;
    await db.buildings.add(building("b1"));
    await db.buildings.delete("b1");
    online.value = true;
    await waitFor(async () => await sent(db, 2) || (await db.outbox.where("state").equals("sent").count()) >= 1, 3000).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    // upsert row read nothing (row gone) and the tombstone found no doc
    expect(server.docs.size).toBe(0);
  });

  it("members (read-only) never enqueue", async () => {
    const { server, db } = await setup(false);
    await db.buildings.add(building("b1"));
    await new Promise((r) => setTimeout(r, 60));
    expect(await db.outbox.count()).toBe(0);
    expect(server.docs.size).toBe(0);
  });

  it("a new IFC version uploads its .frag first, records sha/size/path, then writes the version doc", async () => {
    const { server, bucket, db } = await setup();
    const frag = bytes(64, 7);
    await db.buildings.add(building("b1"));
    await db.transaction("rw", [db.ifcFiles, db.ifcVersions, db.fragBlobs], async () => {
      await db.fragBlobs.put({ key: "i1__v1", blob: frag });
      await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: Date.now(), updatedAt: Date.now() });
      await db.ifcVersions.add({ id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 10, contentHash: "h", fragBlobKey: "i1__v1", storeyCount: 0, createdAt: Date.now(), isLatest: true });
    });
    await waitFor(() => server.docs.has(`${P}/ifcVersions/v1`));
    const path = fragStoragePath(P, "v1");
    expect(bucket.uploads).toEqual([path]);
    const digest = await sha(frag);
    expect(server.docs.get(`${P}/ifcVersions/v1`)!.data).toMatchObject({
      fragStoragePath: path, fragSha256: digest, fragSizeBytes: 64, versionNumber: 1, storagePath: null,
    });
    // blob-upload row was queued before the version row
    const rows = await db.outbox.orderBy("createdAt").toArray();
    const kinds = rows.map((r) => `${r.kind}:${(r.payload as any).versionId ?? (r.payload as any).docId}`);
    expect(kinds.indexOf("blob-upload:v1")).toBeLessThan(kinds.indexOf("doc-upsert:v1"));
    // local row carries the reference too
    expect((await db.ifcVersions.get("v1"))!.fragSha256).toBe(digest);
    expect(bucket.objects.get(path)!.sha256).toBe(digest);
  });

  it("a PDF version uploads its pdf blob and writes the version doc", async () => {
    const { server, bucket, db } = await setup();
    const pdf = bytes(40, 3);
    await db.buildings.add(building("b1"));
    await db.pdfBlobs.put({ key: "bk", bytes: pdf });
    await db.pdfFiles.add({ id: "d1", buildingId: "b1", name: "p.pdf", createdAt: Date.now(), updatedAt: Date.now() });
    await db.pdfVersions.add({ id: "pv1", pdfFileId: "d1", versionNumber: 1, name: "p.pdf", size: 40, contentHash: "h", pageCount: 1, width: 1, height: 1, storedAt: Date.now(), blobKey: "bk", isLatest: true });
    await waitFor(() => server.docs.has(`${P}/pdfVersions/pv1`));
    expect(bucket.uploads).toEqual([pdfStoragePath(P, "pv1")]);
    expect(server.docs.get(`${P}/pdfVersions/pv1`)!.data).toMatchObject({ sizeBytes: 40, contentType: "application/pdf", sha256: await sha(pdf) });
  });

  it("allocates versionNumber at drain time when another device took it", async () => {
    const { server, db, online, engine } = await setup();
    online.value = false;
    await db.buildings.add(building("b1"));
    await db.fragBlobs.put({ key: "k", blob: bytes(8) });
    await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v-local", createdAt: 1, updatedAt: 1 });
    await db.ifcVersions.add({ id: "v-local", ifcFileId: "i1", versionNumber: 2, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k", storeyCount: 0, createdAt: 1, isLatest: true });
    // the other device already published its own v2 and v3 of the same file
    for (const n of [2, 3]) {
      server.put(P, "ifcVersions", `v-remote-${n}`, {
        id: `v-remote-${n}`, ifcFileId: "i1", versionNumber: n, ifcFileSize: 1, contentHash: "x", fragBlobKey: `r${n}`, storeyCount: 0,
        createdAt: 1, isLatest: false, storagePath: null, sha256: null, sizeBytes: null, contentType: null,
        fragStoragePath: null, fragSha256: null, fragSizeBytes: null,
      });
    }
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => server.docs.has(`${P}/ifcVersions/v-local`));
    expect(server.docs.get(`${P}/ifcVersions/v-local`)!.data.versionNumber).toBe(4);
    expect((await db.ifcVersions.get("v-local"))!.versionNumber).toBe(4);
  });

  it("offline: nothing is sent and attempts are not burned; online drains FIFO", async () => {
    const { server, db, online, engine } = await setup();
    online.value = false;
    await db.buildings.add(building("b1"));
    await db.buildings.add(building("b2", "Other"));
    await new Promise((r) => setTimeout(r, 50));
    expect(server.docs.size).toBe(0);
    const rows = await db.outbox.toArray();
    expect(rows.every((r) => r.state === "added" && r.attempts === 0)).toBe(true);
    online.value = true;
    await engine.notifyOnline();
    await waitFor(() => server.docs.size === 2);
    expect(server.writes.map((w) => w.key)).toEqual(["buildings/b1", "buildings/b2"]);
  });

  it("a fatal write error (permission denied) marks the row failed", async () => {
    const { server, db } = await setup();
    server.failNextWrites = 1;
    await db.buildings.add(building("b1"));
    await waitFor(async () => (await db.outbox.where("state").equals("failed").count()) === 1);
    const row = (await db.outbox.toArray())[0];
    expect(row.lastError).toMatch(/permission-denied/);
  });

  it("a missing local blob is a fatal blob-lost failure", async () => {
    const { db } = await setup();
    await db.buildings.add(building("b1"));
    await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: 1, updatedAt: 1 });
    await db.ifcVersions.add({ id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "nope", storeyCount: 0, createdAt: 1, isLatest: true });
    await waitFor(async () => (await db.outbox.where("state").equals("failed").count()) >= 1);
    expect((await db.outbox.where("state").equals("failed").first())!.lastError).toMatch(/blob-lost/);
  });

  it("re-uploading an identical existing object succeeds; a different one is fatal", async () => {
    const { bucket, db, server } = await setup();
    const frag = bytes(16, 5);
    bucket.objects.set(fragStoragePath(P, "v1"), { blob: frag, sha256: await sha(frag) });
    await db.buildings.add(building("b1"));
    await db.fragBlobs.put({ key: "k", blob: frag });
    await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: 1, updatedAt: 1 });
    await db.ifcVersions.add({ id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k", storeyCount: 0, createdAt: 1, isLatest: true });
    await waitFor(() => server.docs.has(`${P}/ifcVersions/v1`));
    expect(bucket.uploads).toEqual([]); // nothing re-uploaded

    bucket.objects.set(fragStoragePath(P, "v2"), { blob: bytes(16, 1), sha256: "f".repeat(64) });
    await db.fragBlobs.put({ key: "k2", blob: frag });
    await db.ifcVersions.add({ id: "v2", ifcFileId: "i1", versionNumber: 2, ifcFileSize: 1, contentHash: "h", fragBlobKey: "k2", storeyCount: 0, createdAt: 2, isLatest: false });
    await waitFor(async () => (await db.outbox.where("state").equals("failed").count()) >= 1);
  });

  it("calibration upsert keeps the server's immutable createdAt when the doc already exists", async () => {
    const { server, db } = await setup();
    const pt = { pdfX: 1, pdfY: 2, worldX: 3, worldZ: 4 };
    server.put(P, "calibrations", "d1__L1", {
      id: "d1__L1", projectId: P, pdfFileId: "d1", storeyName: "L1", pointPairs: [pt, pt],
      transformParams: { scale: 1, rotation: 0, translateX: 0, translateZ: 0 }, confidence: 1, createdAt: 111,
    });
    await waitFor(async () => (await db.calibrations.count()) === 1);
    const local = (await db.calibrations.toArray())[0];
    await db.calibrations.update(local.id, { transformParams: { scale: 5, rotation: 0, translateX: 0, translateZ: 0 }, createdAt: 999 });
    await waitFor(() => (server.docs.get(`${P}/calibrations/d1__L1`)!.data.transformParams as any).scale === 5);
    expect(server.docs.get(`${P}/calibrations/d1__L1`)!.data.createdAt).toBe(111);
  });
});

describe("allocateVersionNumber atomicity", () => {
  it("two concurrent allocations (two tabs) never claim the same number", async () => {
    const { server, db, engine } = await setup();
    void engine;
    await db.buildings.add(building("b1"));
    await db.ifcFiles.add({ id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "va", createdAt: 1, updatedAt: 1 });
    const ver = (id: string, n: number) => ({ id, ifcFileId: "i1", versionNumber: n, ifcFileSize: 1, contentHash: "h", fragBlobKey: `k-${id}`, storeyCount: 0, createdAt: 1, isLatest: false });
    await db.ifcVersions.bulkAdd([ver("va", 2), ver("vb", 3)]);
    for (const n of [2, 3]) server.put(P, "ifcVersions", `v-remote-${n}`, {
      id: `v-remote-${n}`, ifcFileId: "i1", versionNumber: n, ifcFileSize: 1, contentHash: "x", fragBlobKey: "r2", storeyCount: 0,
      createdAt: 1, isLatest: false, storagePath: null, sha256: null, sizeBytes: null, contentType: null,
      fragStoragePath: null, fragSha256: null, fragSizeBytes: null,
    });
    const { allocateVersionNumber } = await import("../src/upSync");
    const { TABLE_BY_COLLECTION } = await import("../src/tables");
    const cfg = TABLE_BY_COLLECTION.ifcVersions;
    const deps = { db, remote: server.remote(), uid: "u", blobs: {} as never };
    const [ra, rb] = await Promise.all(
      ["va", "vb"].map(async (id) => allocateVersionNumber(deps, P, cfg, (await db.ifcVersions.get(id)) as never)),
    );
    const nums = [ra.versionNumber, rb.versionNumber].sort();
    expect(new Set(nums).size).toBe(2);
    expect(nums.every((n) => (n as number) > 2)).toBe(true);
    const stored = (await db.ifcVersions.toArray()).map((v) => v.versionNumber);
    expect(new Set(stored).size).toBe(stored.length);
  });
});
