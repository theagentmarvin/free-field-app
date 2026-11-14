import { describe, expect, it } from "vitest";
import type { OutboxRecord } from "@ff/types";

import { makeTaskBlobStore, outboxBlobKeys, type TaskBlobRow, type TaskBlobTable } from "../src/taskBlobs";

function fakeTable(): TaskBlobTable & { rows: Map<string, TaskBlobRow> } {
  const rows = new Map<string, TaskBlobRow>();
  return {
    rows,
    async put(row) { rows.set(row.blobKey, row); },
    async get(k) { return rows.get(k); },
    async bulkDelete(keys) { for (const k of keys) rows.delete(k); },
    where() {
      return {
        below: (v: number) => ({
          primaryKeys: async () => [...rows.values()].filter((r) => r.createdAt < v).map((r) => r.blobKey),
        }),
      };
    },
  };
}

describe("task blob store (wave 63)", () => {
  it("round-trips bytes and mime through the table", async () => {
    const table = fakeTable();
    const store = makeTaskBlobStore(table, () => 10);
    await store.put("k", new Blob(["hello"], { type: "image/png" }));
    const back = await store.get("k");
    expect(back?.type).toBe("image/png");
    expect(await back?.text()).toBe("hello");
    await store.delete(["k"]);
    expect(await store.get("k")).toBeUndefined();
  });

  it("prunes only aged blobs that no active row references", async () => {
    const table = fakeTable();
    let now = 1;
    const store = makeTaskBlobStore(table, () => now);
    await store.put("old-orphan", new Blob(["a"]));
    await store.put("old-queued", new Blob(["b"]));
    now = 100;
    await store.put("new", new Blob(["c"]));
    expect(await store.pruneOrphans(new Set(["old-queued"]), 50)).toBe(1);
    expect([...table.rows.keys()].sort()).toEqual(["new", "old-queued"]);
  });

  it("lists the photo and location-snapshot keys of a row", () => {
    const row = {
      photoRefs: [{ blobKey: "p1" }, { blobKey: "p2" }],
      payload: { locationThumb: { blobKey: "t1" } },
    } as unknown as OutboxRecord;
    expect(outboxBlobKeys(row)).toEqual(["p1", "p2", "t1"]);
  });
});
