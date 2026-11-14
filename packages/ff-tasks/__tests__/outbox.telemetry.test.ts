// Wave 18 U6 — outbox transition observer (spec §7 U6).
//
// The observer is the seam the telemetry package needs: it reports
// EVERY state transition of the offline write queue so the office can
// see "the site tablet's queue is stuck in `failed`" without shipping
// a single content id.
//
// Contract under test (spec §4.2 / §6 "uuid/kind only"):
//   - the record carries uuid + kind + state ONLY — never the payload,
//     never a taskId/projectId/photoRef/error text;
//   - the hook is OPTIONAL and defaults to undefined (zero cost);
//   - a THROWING observer can never break the state machine.
//
// The engine's own behaviour is unchanged by this unit — the existing
// suite (`outbox.test.ts`) stays green unchanged.

import { describe, it, expect } from "vitest";

import {
  OutboxEngine,
  MAX_ATTEMPTS,
  SENT_RETENTION_MS,
  type OutboxStore,
  type OutboxClock,
  type OutboxExecutor,
  type OutboxTransition,
} from "../src/outbox";
import { buildActionPayload, type TaskActionPayload } from "../src/action";
import type { TaskStatus } from "../src/status";
import type { OutboxRecord } from "@ff/types";

const actor = { uid: "u1", name: "Ana" };

/** A title that must NEVER show up in an observer record. */
const SECRET_TITLE = "Crack in slab — Torre 4";

function payload(
  verb: TaskActionPayload["verb"],
  taskId: string,
  guid: string,
  statusFrom: TaskStatus | null = 40,
): TaskActionPayload {
  return buildActionPayload({
    verb,
    projectId: "p-secret-project",
    taskId,
    statusFrom,
    actor,
    title: SECRET_TITLE,
    guid,
    at: 5,
  });
}

class MemStore implements OutboxStore {
  rows = new Map<string, OutboxRecord>();
  async add(r: OutboxRecord) {
    this.rows.set(r.id, structuredClone(r));
  }
  async put(r: OutboxRecord) {
    this.rows.set(r.id, structuredClone(r));
  }
  async get(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async next(states: readonly string[]) {
    const list = [...this.rows.values()]
      .filter((r) => states.includes(r.state))
      .sort((a, b) => a.createdAt - b.createdAt);
    return list[0] ? structuredClone(list[0]) : undefined;
  }
}

class FakeClock implements OutboxClock {
  nowMs = 1_000_000;
  timers: Array<{ cb: () => void; ms: number }> = [];
  now() {
    return this.nowMs;
  }
  setTimeout(cb: () => void, ms: number) {
    const t = { cb, ms };
    this.timers.push(t);
    return t;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((t) => t !== handle);
  }
  random() {
    return 0.5;
  }
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

function executor(opts?: { failCommits?: number }): OutboxExecutor {
  let commits = 0;
  return {
    async uploadPhotos() {},
    async commit() {
      commits++;
      if (opts?.failCommits && commits <= opts.failCommits) {
        throw new Error("network-blip");
      }
      return { taskId: "t1" };
    },
  };
}

describe("OutboxEngine transition observer (spec §7 U6)", () => {
  it("fires on added → sending → sent with uuid + kind only", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: OutboxTransition[] = [];
    const engine = new OutboxEngine({
      store,
      clock,
      executor: executor(),
      onTransition: (t) => seen.push(t),
    });

    await engine.enqueue(payload("create", "t1", "g1", null));
    await settle();

    expect(seen).toEqual([
      { uuid: "g1", kind: "task-action", state: "added" },
      { uuid: "g1", kind: "task-action", state: "sending" },
      { uuid: "g1", kind: "task-action", state: "sent" },
    ]);

    // uuid + kind + state and NOTHING else — no payload, no content ids.
    for (const record of seen) {
      expect(Object.keys(record).sort()).toEqual(["kind", "state", "uuid"]);
      expect(JSON.stringify(record)).not.toContain(SECRET_TITLE);
      expect(JSON.stringify(record)).not.toContain("p-secret-project");
      expect(JSON.stringify(record)).not.toContain("t1");
    }
  });

  it("is optional — no observer means no cost and unchanged behaviour", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    // NOTE: no `onTransition` at all — the default is undefined.
    const engine = new OutboxEngine({ store, clock, executor: executor() });

    const row = await engine.enqueue(payload("create", "t1", "g2", null));
    expect(row.state).toBe("added");
    await settle();
    expect((await store.get("g2"))?.state).toBe("sent");
  });

  it("a throwing observer never breaks the state machine", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    let calls = 0;
    const engine = new OutboxEngine({
      store,
      clock,
      executor: executor(),
      onTransition: () => {
        calls++;
        throw new Error("observer exploded");
      },
    });

    await engine.enqueue(payload("create", "t1", "g3", null));
    await settle();

    expect(calls).toBeGreaterThanOrEqual(3); // added + sending + sent
    expect((await store.get("g3"))?.state).toBe("sent"); // engine unaffected
  });

  it("fires on failed (attempts exhausted) and on killed (tombstone)", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: OutboxTransition[] = [];
    const engine = new OutboxEngine({
      store,
      clock,
      executor: executor({ failCommits: MAX_ATTEMPTS }),
      onTransition: (t) => seen.push(t),
    });

    await engine.enqueue(payload("comment", "t1", "g4"));
    await settle();
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) await clock.fireNext();

    expect((await store.get("g4"))?.state).toBe("failed");
    expect(seen.map((t) => t.state)).toContain("failed");

    await engine.remove("g4");
    expect((await store.get("g4"))?.state).toBe("killed");
    expect(seen[seen.length - 1]).toEqual({
      uuid: "g4",
      kind: "task-action",
      state: "killed",
    });
  });

  it("fires on the sending → added backoff re-arm (transition, not just state)", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: OutboxTransition[] = [];
    const engine = new OutboxEngine({
      store,
      clock,
      executor: executor({ failCommits: 1 }),
      onTransition: (t) => seen.push(t),
    });

    await engine.enqueue(payload("comment", "t1", "g5"));
    await settle();
    expect((await store.get("g5"))?.state).toBe("sending");

    await clock.fireNext(); // backoff timer re-arms the row to `added`

    expect(seen.map((t) => t.state)).toEqual([
      "added",
      "sending",
      "added", // the re-arm
      "sending",
      "sent",
    ]);
  });

  it("fires on the retention prune (sent → killed)", async () => {
    const store = new MemStore();
    const clock = new FakeClock();
    const seen: OutboxTransition[] = [];
    const engine = new OutboxEngine({
      store,
      clock,
      executor: executor(),
      onTransition: (t) => seen.push(t),
    });

    await engine.enqueue(payload("create", "t1", "g6", null));
    await settle();
    const aged = store.rows.get("g6")!;
    aged.sentAt = clock.nowMs - SENT_RETENTION_MS - 1;

    const pruned = await engine.pruneSent();
    expect(pruned).toBe(1);
    expect(seen[seen.length - 1]).toEqual({
      uuid: "g6",
      kind: "task-action",
      state: "killed",
    });
  });

  it("fires on the cold-start repair (sending → added)", async () => {
    const store = new MemStore();
    const seen: OutboxTransition[] = [];
    const p = payload("create", "t1", "g-crash", null);
    await store.add({
      id: "g-crash",
      kind: "task-action",
      state: "sending",
      projectId: "p1",
      payload: p as unknown as Record<string, unknown>,
      photoRefs: p.photoRefs,
      attempts: 0,
      clientGuid: "g-crash",
      createdAt: 4,
    });
    const engine = new OutboxEngine({
      store,
      clock: new FakeClock(),
      executor: executor(),
      onTransition: (t) => seen.push(t),
    });

    await engine.recoverStale();
    expect(seen).toEqual([
      { uuid: "g-crash", kind: "task-action", state: "added" },
    ]);
    expect((await store.get("g-crash"))?.state).toBe("added");
  });
});
