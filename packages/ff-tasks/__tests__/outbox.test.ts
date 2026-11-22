import { describe, it, expect } from "vitest";

import { OutboxEngine, classifyOutboxError, NETWORK_BACKOFF_BASE_MS, NETWORK_BACKOFF_MAX_MS, BACKOFF_MS, MAX_ATTEMPTS, SENT_RETENTION_MS, type OutboxStore, type OutboxClock, type OutboxExecutor } from "../src/outbox";
import { buildActionPayload, type TaskActionPayload } from "../src/action";
import type { TaskStatus } from "../src/status";
import type { OutboxRecord } from "@ff/types";

/**
 * Engine tests with a hand-driven clock + in-memory store (task-39
 * deliverable 6). The engine is dependency-injected precisely so this
 * needs neither Dexie nor firebase — §4 "kept honest-small".
 */

const actor = { uid: "u1", name: "Ana" };

function payload(verb: TaskActionPayload["verb"], taskId: string, guid: string, statusFrom: TaskStatus | null = 40): TaskActionPayload {
  return buildActionPayload({
    verb,
    projectId: "p1",
    taskId,
    statusFrom,
    actor,
    title: "Crack in slab",
    guid,
    at: 5,
  });
}

class MemStore implements OutboxStore {
  rows = new Map<string, OutboxRecord>();
  async add(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async put(r: OutboxRecord) { this.rows.set(r.id, structuredClone(r)); }
  async get(id: string) { const r = this.rows.get(id); return r ? structuredClone(r) : undefined; }
  async next(states: readonly string[]) {
    const list = [...this.rows.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => a.createdAt - b.createdAt);
    return list[0] ? structuredClone(list[0]) : undefined;
  }
  async list(states: readonly string[]) {
    return [...this.rows.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => structuredClone(r));
  }
  async delete(id: string) { this.rows.delete(id); }
}


function rowFor(p: TaskActionPayload): OutboxRecord {
  return {
    id: p.clientGuid,
    kind: "task-action",
    state: "added",
    projectId: p.projectId,
    payload: p as unknown as Record<string, unknown>,
    photoRefs: p.photoRefs,
    attempts: 0,
    clientGuid: p.clientGuid,
    createdAt: 1,
  };
}

class FakeClock implements OutboxClock {
  nowMs = 1_000_000;
  timers: Array<{ cb: () => void; ms: number }> = [];
  now() { return this.nowMs; }
  setTimeout(cb: () => void, ms: number) {
    const t = { cb, ms };
    this.timers.push(t);
    return t;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((t) => t !== handle);
  }
  random() { return 0.5; } // deterministic jitter: +250ms
  /** fire the next armed timer and settle the engine's promise chain */
  async fireNext() {
    const t = this.timers.shift();
    if (!t) throw new Error("no timer armed");
    this.nowMs += t.ms;
    t.cb();
    await settle();
  }
}

/** let every pending microtask of the engine run to completion */
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function executor(opts?: {
  failCommits?: number;
  failUploads?: number;
}): OutboxExecutor & { calls: string[]; commits(): number; uploads(): number } {
  const calls: string[] = [];
  let commits = 0;
  let uploads = 0;
  return {
    calls,
    commits: () => commits,
    uploads: () => uploads,
    async uploadPhotos() {
      calls.push("upload");
      uploads++;
      if (opts?.failUploads && uploads <= opts.failUploads) throw new Error("upload-blip");
    },
    async commit() {
      calls.push("commit");
      commits++;
      if (opts?.failCommits && commits <= opts.failCommits) throw new Error("server-blip");
      return { taskId: "t1" };
    },
  };
}

describe("OutboxEngine (plan §4, task-39 D5/backoff)", () => {
  it("happy path: added → sending → upload-then-transaction → sent with resultTaskId", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const exec = executor();
    const engine = new OutboxEngine({ store, clock, executor: exec });

    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();
    expect(exec.calls).toEqual(["upload", "commit"]); // binary-first ordering (§3)
    const row = await store.get("g1");
    expect(row?.state).toBe("sent");
    expect(row?.resultTaskId).toBe("t1");
    expect(row?.sentAt).toBe(clock.nowMs);
  });

  it("serial per kind: the drain never overlaps two commits", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: string[] = [];
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit(row) {
        seen.push(row.id);
        if (row.id === "g-a") await gate; // row A parks in commit
      },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec });
    await engine.enqueue(payload("comment", "t1", "g-a"));
    await engine.enqueue(payload("comment", "t1", "g-b"));
    await settle();
    expect(seen).toEqual(["g-a"]); // B NOT started while A in flight
    resolveFirst();
    await settle();
    expect(seen).toEqual(["g-a", "g-b"]); // serial, oldest-first
  });

  it("transient commit failure: attempts++, row stays sending, backoff[0]+jitter armed, timer re-arms to success", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const exec = executor({ failCommits: 1 });
    const engine = new OutboxEngine({ store, clock, executor: exec });

    await engine.enqueue(payload("comment", "t1", "g2"));
    await settle();
    let row = await store.get("g2");
    expect(row?.state).toBe("sending"); // re-armed by the timer, not spun
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("server-blip");
    expect(clock.timers[0]?.ms).toBe(BACKOFF_MS[0] + 250);

    await clock.fireNext();
    row = await store.get("g2");
    expect(row?.state).toBe("sent");
    expect(exec.commits()).toBe(2);
  });

  it("bounded 3 retries then failed; retryNow resets attempts and succeeds", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const exec = executor({ failCommits: MAX_ATTEMPTS }); // commits 1..3 fail
    const engine = new OutboxEngine({ store, clock, executor: exec });

    await engine.enqueue(payload("comment", "t1", "g3"));
    await settle();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await clock.fireNext();

    let row = await store.get("g3");
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(MAX_ATTEMPTS);
    expect(exec.commits()).toBe(MAX_ATTEMPTS);

    await engine.retryNow("g3");
    await settle();
    row = await store.get("g3");
    expect(row?.state).toBe("sent");
    expect(row?.attempts).toBe(0);
  });

  it("upload failure follows the same retry ladder", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const exec = executor({ failUploads: 1 });
    const engine = new OutboxEngine({ store, clock, executor: exec });
    await engine.enqueue(payload("comment", "t1", "g4"));
    await settle();
    const row = await store.get("g4");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("upload-blip");
    expect(row?.state).toBe("sending");
  });

  it("killed mid-flight is not resurrected by a late success", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    let resolveCommit!: () => void;
    const gate = new Promise<void>((r) => (resolveCommit = r));
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit() { await gate; return { taskId: "t1" }; },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec });
    await engine.enqueue(payload("comment", "t1", "g5"));
    await settle(); // drain parked inside commit()
    await engine.remove("g5");
    resolveCommit();
    await settle();
    expect((await store.get("g5"))?.state).toBe("killed");
  });

  it("pruneSent retires rows older than 7 days, keeps fresh ones (legacy store: tombstone)", async () => {
    const store = new MemStore();
    (store as { list?: unknown }).list = undefined;
    (store as { delete?: unknown }).delete = undefined;
    const clock = new FakeClock();
    const engine = new OutboxEngine({ store, clock, executor: executor() });
    await engine.enqueue(payload("create", "t1", "g6", null));
    await settle();
    const aged = store.rows.get("g6")!;
    aged.sentAt = clock.nowMs - SENT_RETENTION_MS - 1;
    await engine.pruneSent();
    expect((await store.get("g6"))?.state).toBe("killed");
  });

  it("replayed enqueue with the same clientGuid cannot double-queue (row id == guid)", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const engine = new OutboxEngine({ store, clock, executor: executor() });
    await engine.enqueue(payload("comment", "t1", "g7"));
    await settle();
    await engine.enqueue(payload("comment", "t1", "g7"));
    await settle();
    expect(store.rows.size).toBe(1); // upsert on the id key
  });

  it("crash recovery: a row stranded in `sending` by a dead tab is demoted and re-committed exactly once (VDC Bug 1)", async () => {
    const store = new MemStore();
    // previous session crashed after process() persisted `sending` but
    // before the upload/commit finished — the backoff timer died with it
    const p = payload("create", "t1", "g-crash", null);
    await store.add({
      id: "g-crash", kind: "task-action", state: "sending", projectId: "p1",
      payload: p as unknown as Record<string, unknown>,
      photoRefs: p.photoRefs, attempts: 0, clientGuid: "g-crash", createdAt: 4,
    });
    const exec = executor();
    const engine = new OutboxEngine({ store, clock: new FakeClock(), executor: exec });
    await engine.drain(); // the old resume path claims nothing — THAT was the bug
    expect(exec.calls).toEqual([]);
    await engine.recoverStale();
    expect((await store.get("g-crash"))?.state).toBe("added");
    await engine.drain();
    expect(exec.calls).toEqual(["upload", "commit"]); // replayed exactly once
    expect((await store.get("g-crash"))?.state).toBe("sent");
  });

  it("recoverStale leaves added/failed/sent/killed rows alone", async () => {
    const store = new MemStore();
    const base: Omit<OutboxRecord, "id" | "state"> = {
      kind: "task-action", projectId: "p1", payload: {}, photoRefs: [],
      attempts: 1, clientGuid: "g-x", createdAt: 1,
    };
    await store.add({ ...base, id: "a", state: "added" });
    await store.add({ ...base, id: "b", state: "failed" });
    await store.add({ ...base, id: "c", state: "sent", sentAt: 2 });
    await store.add({ ...base, id: "d", state: "killed" });
    const engine = new OutboxEngine({ store, clock: new FakeClock(), executor: executor() });
    await engine.recoverStale();
    expect((await store.get("a"))?.state).toBe("added");
    expect((await store.get("b"))?.state).toBe("failed");
    expect((await store.get("c"))?.state).toBe("sent");
    expect((await store.get("d"))?.state).toBe("killed");
  });

  // ── wave 63 ──────────────────────────────────────────────────────

  it("per-task order: a later row waits behind an earlier unsent row of the same task", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: string[] = [];
    let failA = true;
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit(row) {
        seen.push(row.id);
        if (row.id === "g-a" && failA) throw new Error("server hiccup");
      },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec });
    await store.add({ ...rowFor(payload("create", "t1", "g-a", null)), createdAt: 1 });
    await store.add({ ...rowFor(payload("comment", "t1", "g-b")), createdAt: 2 });
    await store.add({ ...rowFor(payload("comment", "t2", "g-c")), createdAt: 3 });
    await engine.drain();
    await settle();
    // A backs off; B (same task) waits; C (other task) goes.
    expect(seen).toEqual(["g-a", "g-c"]);
    expect((await store.get("g-b"))?.state).toBe("added");
    failA = false;
    await clock.fireNext();
    expect(seen).toEqual(["g-a", "g-c", "g-a", "g-b"]);
    expect((await store.get("g-b"))?.state).toBe("sent");
  });

  it("non-retryable errors fail at once (no backoff ladder)", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit() {
        throw Object.assign(new Error("Missing or insufficient permissions."), {
          code: "permission-denied",
        });
      },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec });
    await engine.enqueue(payload("comment", "t1", "g-p"));
    await settle();
    const row = await store.get("g-p");
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toBe("[permission-denied] Missing or insufficient permissions.");
    expect(clock.timers).toHaveLength(0);
    expect(classifyOutboxError(new Error("blob-lost:k1"))).toBe("fatal");
  });

  it("offline: failures don't count attempts, the drain stops, and online revives network-failed rows", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    let online = true;
    let commits = 0;
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit() {
        commits += 1;
        if (!online || commits <= 1) {
          throw Object.assign(new Error("client is offline"), { code: "unavailable" });
        }
      },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec, isOnline: () => online });

    // Offline: the row is not even attempted.
    online = false;
    await engine.enqueue(payload("comment", "t1", "g-o"));
    await settle();
    expect(commits).toBe(0);
    expect((await store.get("g-o"))?.state).toBe("added");

    // The radio flaps: online but every request still fails with a
    // network-class error (navigator.onLine lies on captive Wi-Fi) →
    // the row stays pending with no attempts counted (BUG-13).
    online = true;
    await engine.drain();
    await settle();
    let row = await store.get("g-o");
    expect(row?.state).toBe("added");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toContain("unavailable");

    // Connectivity hint (`online` event) cancels the backoff and retries.
    await engine.reviveNetworkFailed();
    await settle();
    row = await store.get("g-o");
    expect(row?.state).toBe("sent");
  });

  it("a failure observed while offline puts the row back without an attempt", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    let online = true;
    const exec: OutboxExecutor = {
      async uploadPhotos() {},
      async commit() {
        online = false; // connection drops mid-flight
        throw new Error("Failed to fetch");
      },
    };
    const engine = new OutboxEngine({ store, clock, executor: exec, isOnline: () => online });
    await engine.enqueue(payload("comment", "t1", "g-d"));
    await settle();
    const row = await store.get("g-d");
    expect(row?.state).toBe("added");
    expect(row?.attempts).toBe(0);
    expect(clock.timers).toHaveLength(0);
  });

  it("pruneSent deletes aged sent rows and killed tombstones, keeps fresh and active rows", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const engine = new OutboxEngine({ store, clock, executor: executor() });
    const base = rowFor(payload("comment", "t1", "x"));
    await store.add({ ...base, id: "old", state: "sent", sentAt: clock.nowMs - SENT_RETENTION_MS - 1 });
    await store.add({ ...base, id: "fresh", state: "sent", sentAt: clock.nowMs });
    await store.add({ ...base, id: "dead", state: "killed" });
    await store.add({ ...base, id: "queued", state: "failed" });
    expect(await engine.pruneSent()).toBe(2);
    expect([...store.rows.keys()].sort()).toEqual(["fresh", "queued"]);
  });
});

describe("OutboxEngine: backend unreachable while OS reports online (BUG-13)", () => {
  function flaky(err: unknown, failures: number) {
    let commits = 0;
    const ex: OutboxExecutor = {
      async uploadPhotos() {},
      async commit() {
        commits++;
        if (commits <= failures) throw err;
        return { taskId: "t1" };
      },
    };
    return { ex, commits: () => commits };
  }

  it("network error with isOnline()=true: no attempt counted, row stays added, backoff armed, next success clears", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const f = flaky({ code: "unavailable", message: "Connection failed." }, 5);
    const seen: string[] = [];
    const engine = new OutboxEngine({ store, clock, executor: f.ex, isOnline: () => true });
    engine.subscribeReachability((r) => seen.push(r.state));
    expect(engine.getReachability()).toEqual({ state: "unknown", lastNetworkErrorAt: null, lastSuccessAt: null });

    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();
    let row = await store.get("g1");
    expect(row?.state).toBe("added");
    expect(row?.attempts).toBe(0);
    expect(row?.lastError).toBe("[unavailable] Connection failed.");
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0].ms).toBe(NETWORK_BACKOFF_BASE_MS + 250);
    expect(f.commits()).toBe(1); // no spinning
    expect(engine.getReachability().state).toBe("unreachable");
    expect(engine.getReachability().lastNetworkErrorAt).toBe(clock.nowMs);

    // keep failing: stays pending, attempts stay 0, delay doubles and is capped
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await clock.fireNext();
      await settle();
      row = await store.get("g1");
      expect(row?.state).toBe("added");
      expect(row?.attempts).toBe(0);
      delays.push(clock.timers[0]?.ms ?? -1);
    }
    expect(delays[0]).toBe(NETWORK_BACKOFF_BASE_MS * 2 + 250);
    expect(Math.max(...delays)).toBeLessThanOrEqual(NETWORK_BACKOFF_MAX_MS + 500);

    // backend comes back
    await clock.fireNext();
    await settle();
    row = await store.get("g1");
    expect(row?.state).toBe("sent");
    expect(row?.attempts).toBe(0);
    expect(clock.timers).toHaveLength(0);
    expect(engine.getReachability().state).toBe("ok");
    expect(engine.getReachability().lastSuccessAt).toBe(clock.nowMs);
    expect(seen[0]).toBe("unreachable");
    expect(seen[seen.length - 1]).toBe("ok");
  });

  it("resumeNow cancels the backoff and drains immediately", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const f = flaky({ code: "unavailable" }, 1);
    const engine = new OutboxEngine({ store, clock, executor: f.ex, isOnline: () => true });
    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();
    expect(clock.timers).toHaveLength(1);
    await engine.resumeNow();
    await settle();
    expect((await store.get("g1"))?.state).toBe("sent");
    expect(clock.timers).toHaveLength(0);
  });

  it("fatal error (permission-denied) still counts an attempt and fails at once", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const f = flaky({ code: "permission-denied", message: "nope" }, 5);
    const engine = new OutboxEngine({ store, clock, executor: f.ex, isOnline: () => true });
    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();
    const row = await store.get("g1");
    expect(row?.state).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(clock.timers).toHaveLength(0);
    expect(engine.getReachability().state).toBe("ok"); // the server answered
  });

  it("transient error still uses the attempt ladder", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const f = flaky(new Error("weird"), 5);
    const engine = new OutboxEngine({ store, clock, executor: f.ex, isOnline: () => true });
    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();
    const row = await store.get("g1");
    expect(row?.attempts).toBe(1);
    expect(clock.timers[0].ms).toBe(BACKOFF_MS[0] + 250);
    expect(engine.getReachability().state).toBe("unknown");
  });
});
