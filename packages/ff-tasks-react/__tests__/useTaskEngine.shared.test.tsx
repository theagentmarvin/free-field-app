// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { OutboxRecord } from "@ff/types";
import type { TaskBlobStore } from "@ff/tasks";

const engineLog = vi.hoisted(() => ({
  created: 0,
  recoverStale: 0,
  revive: 0,
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@ff/auth", () => ({ useAuthContext: vi.fn() }));
vi.mock("@ff/data/db/database", () => ({
  db: {
    outbox: { where: () => ({ anyOf: () => ({ toArray: async () => [] }) }) },
    drafts: {},
  },
}));
vi.mock("@ff/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/tasks")>();
  return {
    ...actual,
    OutboxEngine: class {
      constructor(opts: Record<string, unknown>) {
        engineLog.created += 1;
        engineLog.options.push(opts);
      }
      async recoverStale() {
        engineLog.recoverStale += 1;
      }
      async pruneSent() {
        return 0;
      }
      async drain() {}
      async reviveNetworkFailed() {
        engineLog.revive += 1;
        return 0;
      }
    },
    makeDexieDraftTable: () => ({}),
    makeDexieOutboxStore: () => ({}),
    getDemoTaskSource: vi.fn(() => ({ executor: vi.fn(() => ({})) })),
  };
});

import { useAuthContext } from "@ff/auth";
import {
  registerBlob,
  releaseRowBlobs,
  resetTaskEnginesForTests,
  taskBlobSource,
  useTaskEngine,
} from "../src/useTaskEngine";

const useAuthContextMock = useAuthContext as unknown as ReturnType<typeof vi.fn>;

function memBlobStore(): TaskBlobStore & { rows: Map<string, Blob>; deleted: string[] } {
  const rows = new Map<string, Blob>();
  const deleted: string[] = [];
  return {
    rows,
    deleted,
    async put(k, b) {
      rows.set(k, b);
    },
    async get(k) {
      return rows.get(k);
    },
    async delete(keys) {
      for (const k of keys) {
        rows.delete(k);
        deleted.push(k);
      }
    },
    async pruneOrphans() {
      return 0;
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  engineLog.created = 0;
  engineLog.recoverStale = 0;
  engineLog.revive = 0;
  engineLog.options = [];
  resetTaskEnginesForTests(memBlobStore());
});

describe("useTaskEngine — shared engine (wave 63)", () => {
  it("every caller gets the same engine; cold-start repair runs once", async () => {
    useAuthContextMock.mockReturnValue({ app: {}, isDemo: true });
    const a = renderHook(() => useTaskEngine());
    const b = renderHook(() => useTaskEngine());
    const c = renderHook(() => useTaskEngine());
    await settle();
    expect(a.result.current).toBe(b.result.current);
    expect(b.result.current).toBe(c.result.current);
    expect(engineLog.created).toBe(1);
    expect(engineLog.recoverStale).toBe(1);
  });

  it("one `online` listener revives network failures on the shared engine", async () => {
    useAuthContextMock.mockReturnValue({ app: {}, isDemo: true });
    renderHook(() => useTaskEngine());
    renderHook(() => useTaskEngine());
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(engineLog.revive).toBe(1);
    // The engine is told about connectivity.
    expect(typeof engineLog.options[0].isOnline).toBe("function");
  });
});

describe("task photo blobs survive a reload (wave 63)", () => {
  it("registered bytes are persisted and read back after the memory cache is gone", async () => {
    const store = memBlobStore();
    resetTaskEnginesForTests(store);
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    registerBlob("k1", blob);
    await settle();
    expect(store.rows.get("k1")).toBe(blob);

    // "Reload": the module memory is empty, the durable store is not.
    resetTaskEnginesForTests(store);
    expect(await taskBlobSource.get("k1")).toBe(blob);
  });

  it("a sent or killed row releases its photo and snapshot bytes", async () => {
    const store = memBlobStore();
    resetTaskEnginesForTests(store);
    registerBlob("p1", new Blob(["a"]));
    registerBlob("thumb1", new Blob(["b"]));
    await settle();
    const row = {
      id: "g1",
      state: "sending",
      photoRefs: [{ blobKey: "p1", sha256: "x", size: 1, mime: "image/jpeg" }],
      payload: { locationThumb: { blobKey: "thumb1", size: 1, mime: "image/jpeg" } },
    } as unknown as OutboxRecord;
    releaseRowBlobs(row); // still in flight: kept
    await settle();
    expect(store.deleted).toEqual([]);
    releaseRowBlobs({ ...row, state: "sent" });
    await settle();
    expect(store.deleted.sort()).toEqual(["p1", "thumb1"]);
    expect(await taskBlobSource.get("p1")).toBeUndefined();
  });
});
