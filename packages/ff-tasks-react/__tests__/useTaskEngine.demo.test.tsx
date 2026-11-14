// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@ff/auth", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@ff/data/db/database", () => ({
  db: { outbox: {}, drafts: {} },
}));

vi.mock("@ff/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/tasks")>();
  return {
    ...actual,
    OutboxEngine: class {
      async recoverStale() {}
      async drain() {}
      async enqueue() { return { id: "row-1" }; }
      async retryNow() {}
      async remove() {}
    },
    makeDexieDraftTable: () => ({
      get: async () => undefined,
      put: async () => undefined,
      delete: async () => undefined,
      whereProject: async () => [],
    }),
    makeDexieOutboxStore: () => ({
      add: async () => undefined,
      put: async () => undefined,
      get: async () => undefined,
      next: async () => undefined,
    }),
    getDemoTaskSource: vi.fn(() => ({
      executor: vi.fn(() => ({
        uploadPhotos: async () => undefined,
        commit: async () => ({ taskId: "t-demo" }),
      })),
    })),
  };
});

import { useAuthContext } from "@ff/auth";
import { getDemoTaskSource } from "@ff/tasks";
import { useTaskEngine } from "../src/useTaskEngine";

const useAuthContextMock = useAuthContext as unknown as ReturnType<typeof vi.fn>;
const getDemoTaskSourceMock = getDemoTaskSource as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useTaskEngine demo seam", () => {
  it("returns a LIVE outbox engine (not null) and swaps the executor source in demo mode", () => {
    useAuthContextMock.mockReturnValue({ app: {}, isDemo: true });
    const { result } = renderHook(() => useTaskEngine());

    expect(result.current).not.toBeNull();
    // the demo engine's executor came from the demo task source, not Firestore
    expect(getDemoTaskSourceMock).toHaveBeenCalledTimes(1);
  });
});