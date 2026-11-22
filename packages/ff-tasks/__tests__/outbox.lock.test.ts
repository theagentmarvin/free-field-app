import { describe, it, expect } from "vitest";
import type { OutboxRecord } from "@ff/types";

import {
  OutboxEngine,
  createOutboxLock,
  type OutboxClock,
  type OutboxExecutor,
  type OutboxStore,
} from "../src/outbox";
import { buildActionPayload } from "../src/action";

/** Minimal exclusive-lock stand-in for `navigator.locks` (FIFO per name). */
class FakeLocks {
  private tails = new Map<string, Promise<unknown>>();
  holders = 0;
  maxHolders = 0;
  request<T>(name: string, cb: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const run = async () => {
      this.holders += 1;
      this.maxHolders = Math.max(this.maxHolders, this.holders);
      try {
        return await cb();
      } finally {
        this.holders -= 1;
      }
    };
    const result = prev.then(run, run);
    this.tails.set(name, result.catch(() => undefined));
    return result;
  }
}

class SharedStore implements OutboxStore {
  rows = new Map<string, OutboxRecord>();
  listCalls = 0;
  async add(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async put(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : undefined; }
  private sel(states: readonly string[]) {
    return [...this.rows.values()].filter((r) => states.includes(r.state)).sort((a, b) => a.createdAt - b.createdAt);
  }
  async next(states: readonly string[]) { const l = this.sel(states)[0]; return l ? structuredClone(l) : undefined; }
  async list(states: readonly string[]) { this.listCalls += 1; return this.sel(states).map((r) => structuredClone(r)); }
  async delete(id: string) { this.rows.delete(id); }
}

const clock: OutboxClock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => 0.5,
};

function row(taskId: string, guid: string, createdAt: number): OutboxRecord {
  const p = buildActionPayload({
    verb: "create", projectId: "p1", taskId, statusFrom: null,
    actor: { uid: "u1", name: "Ana" }, title: "T", guid, at: createdAt,
  });
  return {
    id: guid, kind: "task-action", state: "added", projectId: "p1",
    payload: p as unknown as Record<string, unknown>, photoRefs: [], attempts: 0,
    clientGuid: guid, createdAt,
  };
}

function sendingExecutor(log: string[], tag: string, gate?: Promise<void>): OutboxExecutor & { active: number; maxActive: number } {
  const ex = {
    active: 0,
    maxActive: 0,
    async uploadPhotos() {},
    async commit(r: OutboxRecord) {
      ex.active += 1;
      ex.maxActive = Math.max(ex.maxActive, ex.active);
      await (gate ?? new Promise((res) => setTimeout(res, 5)));
      log.push(`${tag}:${r.id}`);
      ex.active -= 1;
    },
  };
  return ex;
}

describe("OutboxEngine cross-tab lock", () => {
  it("two tabs draining one store send every row exactly once", async () => {
    const locks = new FakeLocks();
    const store = new SharedStore();
    const log: string[] = [];
    const mk = (tag: string) =>
      new OutboxEngine({
        store, clock, executor: sendingExecutor(log, tag),
        lock: createOutboxLock("ff-outbox-tasks", locks),
      });
    const a = mk("A");
    const b = mk("B");
    for (let i = 0; i < 6; i++) await store.add(row(`t${i}`, `g${i}`, i + 1));
    await Promise.all([a.drain(), b.drain()]);
    const ids = log.map((l) => l.split(":")[1]).sort();
    expect(ids).toEqual(["g0", "g1", "g2", "g3", "g4", "g5"]);
    expect(locks.maxHolders).toBe(1);
    expect([...store.rows.values()].every((r) => r.state === "sent")).toBe(true);
  });

  it("recoverStale waits for the live sender instead of demoting its row", async () => {
    const locks = new FakeLocks();
    const store = new SharedStore();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const a = new OutboxEngine({ store, clock, executor: sendingExecutor(log, "A", gate), lock: createOutboxLock("l", locks) });
    const b = new OutboxEngine({ store, clock, executor: sendingExecutor(log, "B"), lock: createOutboxLock("l", locks) });
    await store.add(row("t1", "g1", 1));
    const drainA = a.drain();
    await new Promise((r) => setTimeout(r, 10));
    expect((await store.get("g1"))!.state).toBe("sending"); // A is mid-send
    const recoverB = b.recoverStale();
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.get("g1"))!.state).toBe("sending"); // B did NOT demote it
    release();
    await drainA;
    await recoverB;
    expect((await store.get("g1"))!.state).toBe("sent");
    expect(log).toEqual(["A:g1"]);
  });

  it("recoverStale still repairs a row stranded by a dead tab", async () => {
    const locks = new FakeLocks();
    const store = new SharedStore();
    const stranded = row("t1", "g1", 1);
    stranded.state = "sending";
    await store.add(stranded);
    const b = new OutboxEngine({ store, clock, executor: sendingExecutor([], "B"), lock: createOutboxLock("l", locks) });
    await b.recoverStale();
    expect((await store.get("g1"))!.state).toBe("added");
  });

  it("falls back to an in-process queue when navigator.locks is unavailable", async () => {
    const lock = createOutboxLock("ff-outbox-fallback", null);
    let active = 0;
    let max = 0;
    const work = async () => {
      active += 1;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all([lock.run(work), lock.run(work), lock.run(work)]);
    expect(max).toBe(1);
  });

  it("a throwing holder does not wedge the in-process fallback", async () => {
    const lock = createOutboxLock("ff-outbox-throw", null);
    await expect(lock.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(lock.run(async () => 7)).resolves.toBe(7);
  });
});

describe("OutboxEngine pickNext fast path", () => {
  class CountingStore extends SharedStore {
    countCalls = 0;
    async count(states: readonly string[]) {
      this.countCalls += 1;
      return [...this.rows.values()].filter((r) => states.includes(r.state)).length;
    }
  }
  const quietExecutor = (): OutboxExecutor => ({ async uploadPhotos() {}, async commit() {} });

  it("skips the full active-row listing while nothing is sending/failed", async () => {
    const store = new CountingStore();
    for (let i = 0; i < 5; i++) await store.add(row(`t${i}`, `g${i}`, i + 1));
    const e = new OutboxEngine({ store, clock, executor: quietExecutor() });
    await e.drain();
    expect(store.listCalls).toBe(0);
    expect(store.countCalls).toBeGreaterThan(0);
    expect([...store.rows.values()].every((r) => r.state === "sent")).toBe(true);
  });

  it("still honours per-task ordering when a failed row exists", async () => {
    const store = new CountingStore();
    const failed = row("t1", "g1", 1);
    failed.state = "failed";
    await store.add(failed);
    await store.add(row("t1", "g2", 2)); // blocked behind the failed row
    await store.add(row("t2", "g3", 3)); // independent
    const e = new OutboxEngine({ store, clock, executor: quietExecutor() });
    await e.drain();
    expect((await store.get("g2"))!.state).toBe("added");
    expect((await store.get("g3"))!.state).toBe("sent");
    expect(store.listCalls).toBeGreaterThan(0);
  });
});
