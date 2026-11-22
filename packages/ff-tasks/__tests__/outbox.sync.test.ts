import { describe, it, expect } from "vitest";
import type { OutboxRecord } from "@ff/types";

import { OutboxEngine, type OutboxStore, type OutboxClock } from "../src/outbox";
import { makeDexieOutboxStore } from "../src/dexieStore";

/** Generalization for the Phase 1c/1d sync kinds: enqueueRow + orderKey, and the task store ignoring sync rows. */

class MemStore implements OutboxStore {
  rows = new Map<string, OutboxRecord>();
  async add(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async put(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : undefined; }
  async next(s: readonly string[]) { return (await this.list(s))[0]; }
  async list(s: readonly string[]) {
    return [...this.rows.values()].filter((r) => s.includes(r.state)).sort((a, b) => a.createdAt - b.createdAt).map((r) => structuredClone(r));
  }
}
const clock: OutboxClock = { now: () => 1, setTimeout: () => 0, clearTimeout: () => undefined, random: () => 0 };
const row = (id: string, kind: OutboxRecord["kind"], key: string, createdAt: number): OutboxRecord => ({
  id, kind, state: "added", projectId: "p", payload: { docId: key }, photoRefs: [], attempts: 0, clientGuid: id, createdAt,
});

describe("OutboxEngine generalization", () => {
  it("enqueueRow runs a non-task row through the same state machine", async () => {
    const store = new MemStore();
    const done: string[] = [];
    const engine = new OutboxEngine({
      store, clock,
      executor: { uploadPhotos: async () => undefined, commit: async (r) => { done.push(r.id); } },
    });
    await engine.enqueueRow(row("a", "doc-upsert", "d1", 1));
    for (let i = 0; i < 50 && done.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(done).toEqual(["a"]);
    expect((await store.get("a"))!.state).toBe("sent");
  });

  it("orderKey: a failed row blocks later rows of ITS key only", async () => {
    const store = new MemStore();
    const done: string[] = [];
    const engine = new OutboxEngine({
      store, clock,
      orderKey: (r) => (r.payload as { docId: string }).docId,
      executor: {
        uploadPhotos: async () => undefined,
        commit: async (r) => {
          if (r.id === "a1") throw Object.assign(new Error("no"), { code: "permission-denied" });
          done.push(r.id);
        },
      },
    });
    await store.add(row("a1", "blob-upload", "k", 1));
    await store.add(row("a2", "doc-upsert", "k", 2));
    await store.add(row("b1", "doc-upsert", "other", 3));
    await engine.drain();
    expect((await store.get("a1"))!.state).toBe("failed");
    expect(done).toEqual(["b1"]); // a2 waits behind failed a1; unrelated b1 proceeds
    expect((await store.get("a2"))!.state).toBe("added");
  });

  it("the task outbox store never hands out sync rows", async () => {
    const data: OutboxRecord[] = [row("t", "task-action", "x", 1), row("s", "doc-upsert", "y", 2)];
    const table = {
      put: async () => undefined, get: async () => undefined, delete: async () => undefined,
      where: () => ({
        anyOf: () => ({ sortBy: async () => data, toArray: async () => data }),
        equals: () => ({ toArray: async () => [] }),
      }),
    };
    const store = makeDexieOutboxStore(table as never);
    expect((await store.list!(["added"])).map((r) => r.id)).toEqual(["t"]);
    expect((await store.next(["added"]))!.id).toBe("t");
  });
});
