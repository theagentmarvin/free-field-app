import { afterEach, describe, expect, it } from "vitest";

import { TABLES, createSyncEngine, type SyncEngine } from "../src";
import { FakeBucket, FakeServer, freshDb, waitFor } from "./fakes";

const SET = TABLES.length;
let engines: SyncEngine[] = [];
afterEach(() => {
  engines.forEach((e) => e.dispose());
  engines = [];
});

function make(onFirstSubscribe?: () => void) {
  const server = new FakeServer();
  const bucket = new FakeBucket();
  const base = server.remote();
  let subscribes = 0;
  const remote = {
    ...base,
    subscribe: (...args: Parameters<typeof base.subscribe>) => {
      subscribes += 1;
      if (subscribes === 1) onFirstSubscribe?.();
      return base.subscribe(...args);
    },
  };
  const engine = createSyncEngine({
    db: freshDb(),
    remote,
    transport: bucket.transport(),
    uid: "admin-1",
    isOnline: () => true,
  });
  engines.push(engine);
  return { server, engine };
}

describe("SyncEngine start/stop races", () => {
  it("start then immediate stop leaves no listeners", async () => {
    const { server, engine } = make();
    const p = engine.start("p1", { canWrite: true });
    engine.stop();
    await p;
    await new Promise((r) => setTimeout(r, 30));
    expect(server.listeners.size).toBe(0);
  });

  it("stop while startDownSync is subscribing disposes that start's listeners", async () => {
    let engineRef: SyncEngine | null = null;
    const h = make(() => engineRef?.stop());
    engineRef = h.engine;
    await h.engine.start("p1", { canWrite: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.server.listeners.size).toBe(0);
  });

  it("start -> stop -> start (StrictMode) ends with exactly one listener set", async () => {
    const { server, engine } = make();
    const p1 = engine.start("p1", { canWrite: true });
    engine.stop();
    const p2 = engine.start("p1", { canWrite: true });
    await Promise.all([p1, p2]);
    await waitFor(() => server.listeners.size === SET);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.listeners.size).toBe(SET);
    engine.stop();
    expect(server.listeners.size).toBe(0);
  });

  it("repeated project switches and role toggles never accumulate listeners", async () => {
    const { server, engine } = make();
    const runs: Promise<void>[] = [];
    for (let i = 0; i < 6; i += 1) {
      runs.push(engine.start(i % 2 ? "p1" : "p2", { canWrite: i % 3 !== 0 }));
      if (i % 2 === 0) engine.stop();
    }
    await Promise.all(runs);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.listeners.size).toBe(SET);
    engine.dispose();
    expect(server.listeners.size).toBe(0);
  });
});
