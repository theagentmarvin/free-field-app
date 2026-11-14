import { describe, it, expect } from "vitest";

import { photoPath, entryData, allocateNum, createTaskExecutor } from "../src/repository";
import { buildActionPayload, type TaskActionPayload } from "../src/action";
import { locationThumbPath } from "../src/photos";
import type { OutboxRecord } from "@ff/types";

/**
 * Pure pieces of the commit path (task-39 deliverable 6: counter
 * allocation + idempotent entry keys). The transaction itself and the
 * rules matrix are covered by the ff-firestore emulator suite.
 */

const actor = { uid: "u1", name: "Ana" };

function payload(over: Partial<TaskActionPayload> = {}): TaskActionPayload {
  return buildActionPayload({
    verb: "comment",
    projectId: "p1",
    taskId: "t1",
    statusFrom: 20,
    actor,
    title: "Crack in slab",
    guid: "g1",
    at: 1000,
    ...over,
  });
}

describe("photoPath (§2.3 D3 shape)", () => {
  it("projects/{pid}/tasks/{taskId}/{sha12}-{index}.{ext}, mime-mapped", () => {
    const p = payload({
      photoRefs: [
        { blobKey: "b0", sha256: "a".repeat(64), size: 1, mime: "image/jpeg" },
        { blobKey: "b1", sha256: "b".repeat(63) + "c", size: 1, mime: "image/png" },
        { blobKey: "b2", sha256: "d".repeat(64), size: 1, mime: "image/webp" },
      ],
    });
    expect(photoPath(p, 0)).toBe(`projects/p1/tasks/t1/${"a".repeat(12)}-0.jpg`);
    expect(photoPath(p, 1)).toBe(`projects/p1/tasks/t1/${"b".repeat(12)}-1.png`);
    expect(photoPath(p, 2)).toBe(`projects/p1/tasks/t1/${"d".repeat(12)}-2.webp`);
  });
});

describe("entryData (§2.3) — docId == clientGuid == id", () => {
  it("stamps actor, timestamps and the traversed edge", () => {
    const e = entryData(payload({ text: "fixed formwork" }), []);
    expect(e.id).toBe("g1");
    expect(e.clientGuid).toBe("g1");
    expect(e.by).toBe("Ana");
    expect(e.byUid).toBe("u1");
    expect(e.statusFrom).toBe(20);
    expect(e.statusTo).toBe(20);
    expect(e.at).toBe(1000);
  });

  it("carries per-action photo metadata", () => {
    const p = payload({
      photoRefs: [{ blobKey: "b", sha256: "e".repeat(64), size: 7, mime: "image/jpeg" }],
    });
    const photos = [{ storagePath: photoPath(p, 0), sha256: "e".repeat(64), size: 7, mime: "image/jpeg" }];
    const e = entryData(p, photos);
    expect(e.photos).toHaveLength(1);
    expect(e.photos[0].storagePath).toContain("projects/p1/tasks/t1/");
  });
});

describe("allocateNum (§2.2 num) — rules mirror this shape", () => {
  it("first allocation is 1 and writes next=1", () => {
    expect(allocateNum(null)).toEqual({ num: 1, next: 1 });
  });
  it("subsequent allocations are exactly +1 (rules reject skips)", () => {
    expect(allocateNum({ next: 1 })).toEqual({ num: 2, next: 2 });
    expect(allocateNum({ next: 41 })).toEqual({ num: 42, next: 42 });
  });
});

describe("executor.uploadPhotos — location thumb bytes-first", () => {
  it("uploads the fixed-name thumb when one is present (idempotent by path)", async () => {
    const uploaded: Array<{ path: string; blob: Blob }> = [];
    const storagePort = {
      exists: async (path: string) => false,
      upload: async (path: string, blob: Blob) => {
        uploaded.push({ path, blob });
      },
    };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const blobs = { get: async (key: string) => (key === "thumb" ? blob : undefined) };
    const executor = createTaskExecutor(
      undefined as unknown as Parameters<typeof createTaskExecutor>[0],
      storagePort,
      blobs,
    );

    const payload = buildActionPayload({
      verb: "create",
      projectId: "p1",
      taskId: "t1",
      statusFrom: null,
      actor,
      title: "x",
      guid: "g1",
      at: 1,
      locationThumb: { blobKey: "thumb", size: 3, mime: "image/jpeg" },
    });
    const row = { payload: payload as unknown as Record<string, unknown> } as OutboxRecord;

    await executor.uploadPhotos(row);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0].path).toBe(locationThumbPath("p1", "t1"));
    expect(uploaded[0].blob).toBe(blob);
  });

  it("skips the thumb when one is not captured", async () => {
    const uploaded: Array<{ path: string; blob: Blob }> = [];
    const executor = createTaskExecutor(
      undefined as unknown as Parameters<typeof createTaskExecutor>[0],
      {
        exists: async () => false,
        upload: async (path: string, blob: Blob) => {
          uploaded.push({ path, blob });
        },
      },
      { get: async () => undefined },
    );
    const payload = buildActionPayload({
      verb: "create",
      projectId: "p1",
      taskId: "t1",
      statusFrom: null,
      actor,
      title: "x",
      guid: "g1",
      at: 1,
      locationThumb: null,
    });
    const row = { payload: payload as unknown as Record<string, unknown> } as OutboxRecord;
    await executor.uploadPhotos(row);
    expect(uploaded).toHaveLength(0);
  });
});
