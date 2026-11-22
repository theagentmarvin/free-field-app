import { afterEach, describe, expect, it } from "vitest";
import { setBlobMissHandler } from "@ff/data/db/tables/blobMiss";
import { fragStoragePath, pdfStoragePath } from "@ff/firestore";

import { BlobIntegrityError, registerBlobMissHandler, type BlobSink, type SyncEngine } from "../src";
import { createSyncEngine } from "../src";
import { FakeBucket, FakeServer, bytes, freshDb, sha, waitFor } from "./fakes";

const P = "proj-1";
let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
  setBlobMissHandler(null);
});

async function publishedBuilding(server: FakeServer, bucket: FakeBucket, frag: Blob, pdf: Blob) {
  const fragPath = fragStoragePath(P, "v1");
  const pdfPath = pdfStoragePath(P, "pv1");
  bucket.objects.set(fragPath, { blob: frag, sha256: await sha(frag) });
  bucket.objects.set(pdfPath, { blob: pdf, sha256: await sha(pdf) });
  server.put(P, "buildings", "b1", { id: "b1", projectId: P, name: "T", metadata: {}, createdAt: 1 });
  server.put(P, "ifcFiles", "i1", { id: "i1", buildingId: "b1", name: "m.ifc", currentVersionId: "v1", createdAt: 1 });
  server.put(P, "ifcVersions", "v1", {
    id: "v1", ifcFileId: "i1", versionNumber: 1, ifcFileSize: 1, contentHash: "h", fragBlobKey: "fk", storeyCount: 0, createdAt: 1, isLatest: true,
    storagePath: null, sha256: null, sizeBytes: null, contentType: null,
    fragStoragePath: fragPath, fragSha256: await sha(frag), fragSizeBytes: frag.size,
  });
  server.put(P, "pdfFiles", "d1", { id: "d1", buildingId: "b1", name: "p.pdf", createdAt: 1 });
  server.put(P, "pdfVersions", "pv1", {
    id: "pv1", pdfFileId: "d1", versionNumber: 1, name: "p.pdf", size: pdf.size, contentHash: "h", pageCount: 1, width: 1, height: 1,
    storedAt: 1, blobKey: "pk", isLatest: true, storagePath: pdfPath, sha256: await sha(pdf), sizeBytes: pdf.size, contentType: "application/pdf",
  });
}

async function reader(server: FakeServer, bucket: FakeBucket, sink?: BlobSink) {
  const db = freshDb();
  const engine = createSyncEngine({ db, remote: server.remote(), transport: bucket.transport(), uid: "m1", sink });
  engines.push(engine);
  await engine.start(P, { canWrite: false });
  await waitFor(async () => !!(await db.pdfVersions.get("pv1")) && !!(await db.ifcVersions.get("v1")));
  return { engine, db };
}

describe("blob download", () => {
  it("downloads a building's latest .frag and PDF into the local tables, verified", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    const frag = bytes(32, 4);
    const pdf = bytes(24, 6);
    await publishedBuilding(server, bucket, frag, pdf);
    const { engine, db } = await reader(server, bucket);
    const progress: number[] = [];
    engine.subscribe((e) => e.type === "blob-done" && progress.push(1));
    const r = await engine.downloadBuilding("b1");
    expect(r).toMatchObject({ downloaded: 2, present: 0, failed: [] });
    expect(await sha((await db.fragBlobs.get("fk"))!.blob)).toBe(await sha(frag));
    expect(await sha((await db.pdfBlobs.get("pk"))!.bytes)).toBe(await sha(pdf));
    // second call: present, no extra network
    const n = bucket.downloads.length;
    expect(await engine.downloadBuilding("b1")).toMatchObject({ downloaded: 0, present: 2 });
    expect(bucket.downloads).toHaveLength(n);
  });

  it("rejects a corrupted download (sha256 mismatch) and stores nothing", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    await publishedBuilding(server, bucket, bytes(32, 4), bytes(24, 6));
    bucket.corrupt.add(fragStoragePath(P, "v1"));
    const { engine, db } = await reader(server, bucket);
    const r = await engine.downloadBuilding("b1");
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].error).toMatch(/integrity/);
    expect(await db.fragBlobs.get("fk")).toBeUndefined();
    expect(r.downloaded).toBe(1); // the PDF still came down
    expect(new BlobIntegrityError("frag", "v1", "x").name).toBe("BlobIntegrityError");
  });

  it("writes through an injected BlobSink (mobile filesystem)", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    await publishedBuilding(server, bucket, bytes(32, 4), bytes(24, 6));
    const files = new Map<string, Blob>();
    const sink: BlobSink = {
      async has(k, key) { return files.has(`${k}:${key}`); },
      async put(k, key, blob) { files.set(`${k}:${key}`, blob); },
    };
    const { engine, db } = await reader(server, bucket, sink);
    await engine.downloadBuilding("b1");
    expect([...files.keys()].sort()).toEqual(["frag:fk", "pdf:pk"]);
    expect(await db.fragBlobs.get("fk")).toBeUndefined(); // not written to Dexie
  });

  it("streams through putFromUrl + getDownloadUrl without calling download()", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    const frag = bytes(32, 4);
    const pdf = bytes(24, 6);
    await publishedBuilding(server, bucket, frag, pdf);
    const calls: Array<{ kind: string; key: string; url: string; expected: { sha256: string; sizeBytes?: number } }> = [];
    const sink: BlobSink = {
      async has(k, key) { return calls.some((c) => c.kind === k && c.key === key); },
      async put() { throw new Error("whole-blob put must not be used"); },
      async putFromUrl(kind, key, url, expected, opts) {
        calls.push({ kind, key, url, expected });
        opts?.onProgress?.(1, 1);
      },
    };
    const db = freshDb();
    const engine = createSyncEngine({ db, remote: server.remote(), transport: bucket.transport({ withUrls: true }), uid: "m1", sink });
    engines.push(engine);
    await engine.start(P, { canWrite: false });
    await waitFor(async () => !!(await db.pdfVersions.get("pv1")) && !!(await db.ifcVersions.get("v1")));
    const r = await engine.downloadBuilding("b1");
    expect(r).toMatchObject({ downloaded: 2, failed: [] });
    expect(bucket.downloads).toHaveLength(0); // never pulled into memory
    const frag1 = calls.find((c) => c.kind === "frag")!;
    expect(frag1.url).toBe(`fake://bucket/${fragStoragePath(P, "v1")}`);
    expect(frag1.expected).toEqual({ sha256: await sha(frag), sizeBytes: frag.size });
    expect(calls.find((c) => c.kind === "pdf")!.expected.sha256).toBe(await sha(pdf));
  });

  it("falls back to download() + put() when the transport has no getDownloadUrl", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    await publishedBuilding(server, bucket, bytes(32, 4), bytes(24, 6));
    let streamed = 0;
    const files = new Map<string, Blob>();
    const sink: BlobSink = {
      async has(k, key) { return files.has(`${k}:${key}`); },
      async put(k, key, blob) { files.set(`${k}:${key}`, blob); },
      async putFromUrl() { streamed += 1; },
    };
    const { engine } = await reader(server, bucket, sink);
    await engine.downloadBuilding("b1");
    expect(streamed).toBe(0);
    expect(files.size).toBe(2);
  });

  it("lazy: getFragBlob misses -> handler downloads on first open", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    const frag = bytes(32, 4);
    await publishedBuilding(server, bucket, frag, bytes(8));
    const { engine, db } = await reader(server, bucket);
    // ff-data's accessors read the singleton db; call the handler path the same way they do.
    const un = registerBlobMissHandler(engine);
    const { runBlobMissHandler } = await import("@ff/data/db/tables/blobMiss");
    expect(await runBlobMissHandler("frag", "fk")).toBe(true);
    expect((await db.fragBlobs.get("fk"))!.blob.size).toBe(32);
    expect(await runBlobMissHandler("frag", "unknown")).toBe(false);
    un();
    expect(await runBlobMissHandler("frag", "fk")).toBe(false);
  });

  it("versions without an uploaded blob are 'unavailable' (never throw)", async () => {
    const server = new FakeServer();
    const bucket = new FakeBucket();
    await publishedBuilding(server, bucket, bytes(4), bytes(4));
    server.put(P, "ifcVersions", "v1", { ...server.docs.get(`${P}/ifcVersions/v1`)!.data, fragStoragePath: null, fragSha256: null, fragSizeBytes: null });
    const { engine, db } = await reader(server, bucket);
    await waitFor(async () => (await db.ifcVersions.get("v1"))!.fragSha256 === null);
    expect(await engine.downloadBuilding("b1")).toMatchObject({ unavailable: 1, downloaded: 1 });
  });
});
