import { describe, it, expect } from "vitest";

import type { Task, TaskEntry } from "@ff/firestore";
import type { OutboxRecord } from "@ff/types";

import {
  DemoTaskSource,
  demoLatencyMs,
  type DemoTaskStore,
} from "../src/demoTaskSource";
import { buildActionPayload, type TaskActionPayload } from "../src/action";
import { locationThumbPath } from "../src/photos";

/**
 * Demo task data plane (login-free) — state-machine parity with the
 * cloud commit, counter allocation, entry appends, terminal rejection,
 * live-watch emission, photo data-URL round-trip, and idempotent seed.
 * All against an injected in-memory store — no Dexie, no timers.
 */

class MemDemoStore implements DemoTaskStore {
  tasks = new Map<string, Task>();
  entriesByTask = new Map<string, TaskEntry[]>();
  counter: { next: number } | undefined;
  photos = new Map<string, string>();

  async putTask(_pid: string, task: Task) { this.tasks.set(task.id, structuredClone(task)); }
  async getTask(id: string) { const t = this.tasks.get(id); return t ? structuredClone(t) : undefined; }
  async listTasks() { return [...this.tasks.values()].map((t) => structuredClone(t)); }
  async countTasks() { return this.tasks.size; }
  async putEntry(_pid: string, taskId: string, entry: TaskEntry) {
    const list = this.entriesByTask.get(taskId) ?? [];
    list.push(structuredClone(entry));
    this.entriesByTask.set(taskId, list);
  }
  async listEntries(_pid: string, taskId: string) {
    return (this.entriesByTask.get(taskId) ?? []).map((e) => structuredClone(e));
  }
  async getCounter() { return this.counter ? { ...this.counter } : undefined; }
  async putCounter(_pid: string, c: { next: number }) { this.counter = { ...c }; }
  async putPhoto(p: string, d: string) { this.photos.set(p, d); }
  async getPhoto(p: string) { return this.photos.get(p); }
}

const zeroLatency = { wait: async () => undefined };
const actor = { uid: "u1", name: "Ana" };

function makeSource(store?: MemDemoStore): { source: DemoTaskSource; store: MemDemoStore } {
  const mem = store ?? new MemDemoStore();
  return { source: new DemoTaskSource({ store: mem, latency: zeroLatency }), store: mem };
}

function payload(over: Partial<Omit<TaskActionPayload, "verb">> & { verb: TaskActionPayload["verb"] }): TaskActionPayload {
  return buildActionPayload({
    verb: over.verb,
    projectId: "p1",
    taskId: over.taskId ?? "t1",
    statusFrom: (over.statusFrom ?? null) as TaskActionPayload["statusFrom"],
    actor,
    title: over.title ?? "Crack in slab",
    guid: over.clientGuid ?? `g-${Math.random().toString(36).slice(2)}`,
    at: over.at ?? 5,
    text: over.text,
    photoRefs: over.photoRefs ?? [],
    createDoc: over.createDoc,
    patch: over.patch,
  });
}

function row(p: TaskActionPayload): OutboxRecord {
  return {
    id: p.clientGuid,
    kind: "task-action",
    state: "added",
    projectId: p.projectId,
    payload: p as unknown as Record<string, unknown>,
    photoRefs: p.photoRefs,
    attempts: 0,
    clientGuid: p.clientGuid,
    createdAt: p.at,
  };
}

async function commit(source: DemoTaskSource, p: TaskActionPayload): Promise<void> {
  await source.executor({
    get: async () => undefined,
  }).commit!(row(p));
}

const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("DemoTaskSource state-machine parity", () => {
  it("create → inbox(10), num from local counter; assign → ongoing(20); complete → awaiting(40); approve → 65", async () => {
    const { source, store } = makeSource();

    const create = payload({ verb: "create", taskId: "t1", statusFrom: null, createDoc: { description: "first" } });
    await commit(source, create);
    let task = store.tasks.get("t1")!;
    expect(task.status).toBe(10);
    expect(task.num).toBe(1);
    expect(task.entryCount).toBe(1);
    expect(store.counter).toEqual({ next: 1 });

    const assign = payload({ verb: "assign", taskId: "t1", statusFrom: 10, patch: { assigneeUid: "u1", assigneeName: "Ana" } });
    await commit(source, assign);
    task = store.tasks.get("t1")!;
    expect(task.status).toBe(20);
    expect(task.entryCount).toBe(2);

    const complete = payload({ verb: "complete", taskId: "t1", statusFrom: 20 });
    await commit(source, complete);
    expect(store.tasks.get("t1")!.status).toBe(40);

    const approve = payload({ verb: "approve", taskId: "t1", statusFrom: 40 });
    await commit(source, approve);
    task = store.tasks.get("t1")!;
    expect(task.status).toBe(65);
    expect(task.entryCount).toBe(4);
    expect(store.entriesByTask.get("t1")).toHaveLength(4);
  });

  it("counter continues across creates (T001, T002, T003)", async () => {
    const { source, store } = makeSource();
    await commit(source, payload({ verb: "create", taskId: "a", statusFrom: null }));
    await commit(source, payload({ verb: "create", taskId: "b", statusFrom: null }));
    await commit(source, payload({ verb: "create", taskId: "c", statusFrom: null }));
    expect(store.tasks.get("a")!.num).toBe(1);
    expect(store.tasks.get("b")!.num).toBe(2);
    expect(store.tasks.get("c")!.num).toBe(3);
    expect(store.counter).toEqual({ next: 3 });
  });

  it("entries append with the traversed edge + actor stamps", async () => {
    const { source, store } = makeSource();
    await commit(source, payload({ verb: "create", taskId: "t1", statusFrom: null, text: "opened" }));
    const entries = store.entriesByTask.get("t1")!;
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.action).toBe("create");
    expect(e.text).toBe("opened");
    expect(e.by).toBe("Ana");
    expect(e.statusFrom).toBe(null);
    expect(e.statusTo).toBe(10);
    expect(e.clientGuid).toBe(e.id);
  });

  it("a stray update on a missing task throws task-not-found (cloud-parity message)", async () => {
    const { source } = makeSource();
    await expect(
      source.executor({ get: async () => undefined }).commit!(row(payload({ verb: "comment", taskId: "ghost", statusFrom: 10 }))),
    ).rejects.toThrow("task-not-found");
  });

  it("a status-conflict update throws status-conflict (cloud-parity message)", async () => {
    const { source } = makeSource();
    await commit(source, payload({ verb: "create", taskId: "t1", statusFrom: null }));
    await expect(
      commit(source, payload({ verb: "approve", taskId: "t1", statusFrom: 40 })),
    ).rejects.toThrow("status-conflict");
  });

  it("replayed create with the same clientGuid is idempotent (no double T-number, no double entry)", async () => {
    const { source, store } = makeSource();
    const p = payload({ verb: "create", taskId: "t1", statusFrom: null, clientGuid: "fixed-guid" });
    await commit(source, p);
    await commit(source, p); // replay after crash / backoff
    expect(store.tasks.get("t1")!.num).toBe(1);
    expect(store.counter).toEqual({ next: 1 });
    expect(store.entriesByTask.get("t1")).toHaveLength(1);
  });

  it("terminal statuses reject via buildActionPayload (no further transition)", async () => {
    const { source } = makeSource();
    await commit(source, payload({ verb: "create", taskId: "t1", statusFrom: null }));
    await commit(source, payload({ verb: "assign", taskId: "t1", statusFrom: 10 }));
    await commit(source, payload({ verb: "complete", taskId: "t1", statusFrom: 20 }));
    await commit(source, payload({ verb: "approve", taskId: "t1", statusFrom: 40 }));
    // terminal 65 accepts no verb
    expect(() => buildActionPayload({ verb: "comment", projectId: "p1", taskId: "t1", statusFrom: 65, actor, title: "x" })).toThrow();
  });
});

describe("DemoTaskSource live watch", () => {
  it("watchTasks emits on commit; watchTask/watchTaskEntries track one task", async () => {
    const { source } = makeSource();
    const seen: Task[][] = [];
    const unsub = source.watchTasks("p1", null, (tasks) => seen.push(tasks), 50);
    await settle();
    expect(seen[seen.length - 1]).toHaveLength(0);

    await commit(source, payload({ verb: "create", taskId: "t1", statusFrom: null, title: "Seeded" }));
    await settle();
    const last = seen[seen.length - 1];
    expect(last).toHaveLength(1);
    expect(last[0].title).toBe("Seeded");
    expect(last[0].num).toBe(1);

    const taskBox: { task: Task | null } = { task: null };
    const unsubTask = source.watchTask("p1", "t1", (t) => { taskBox.task = t; });
    await settle();
    expect(taskBox.task?.title).toBe("Seeded");

    const entriesBox: { entries: TaskEntry[] } = { entries: [] };
    const unsubEntries = source.watchTaskEntries("p1", "t1", (e) => { entriesBox.entries = e; });
    await settle();
    expect(entriesBox.entries).toHaveLength(1);

    unsub(); unsubTask(); unsubEntries();
  });
});

describe("DemoTaskSource photo round-trip", () => {
  it("returns the stored data URL keyed by storagePath", async () => {
    const { source, store } = makeSource();
    await store.putPhoto("projects/p1/tasks/t1/abc-0.png", "data:image/png;base64,AAA");
    expect(await source.resolvePhotoUrl("projects/p1/tasks/t1/abc-0.png")).toBe("data:image/png;base64,AAA");
    expect(await source.resolvePhotoUrl("missing.png")).toBeNull();
  });
});

describe("demoLatencyMs", () => {
  it("is bounded to 300..799 for any random() in [0,1)", () => {
    expect(demoLatencyMs(() => 0)).toBe(300);
    expect(demoLatencyMs(() => 0.999999)).toBe(799);
    for (let i = 0; i < 100; i++) {
      const v = demoLatencyMs(() => i / 100);
      expect(v).toBeGreaterThanOrEqual(300);
      expect(v).toBeLessThan(800);
    }
  });
});
describe("DemoTaskSource location thumb (Architect integration fix)", () => {
  it("uploads the snapshot blob under locationThumbPath; idempotent on retry", async () => {
    const { source, store } = makeSource();
    const p: TaskActionPayload = {
      ...payload({ verb: "create", taskId: "t1", statusFrom: null, createDoc: { description: "x" } }),
      locationThumb: { blobKey: "thumb1", size: 3, mime: "image/jpeg" },
    };
    const blobs = {
      get: async (key: string) => (key === "thumb1" ? new Blob(["abc"], { type: "image/jpeg" }) : undefined),
    };
    const exec = source.executor(blobs);
    await exec.uploadPhotos!(row(p));
    const path = locationThumbPath("p1", "t1");
    expect(await store.getPhoto(path)).toMatch(/^data:image\/jpeg;base64,/);
    // replay: path already stored → must NOT re-read blobs (no blob-lost)
    const dead = { get: async () => undefined };
    await expect(source.executor(dead).uploadPhotos!(row(p))).resolves.toBeUndefined();
  });
  it("throws blob-lost when the thumb blob is missing on first attempt", async () => {
    const { source } = makeSource();
    const p: TaskActionPayload = {
      ...payload({ verb: "create", taskId: "t9", statusFrom: null }),
      locationThumb: { blobKey: "gone", size: 1, mime: "image/jpeg" },
    };
    await expect(source.executor({ get: async () => undefined }).uploadPhotos!(row(p))).rejects.toThrow(/blob-lost/);
  });
});
