// @vitest-environment jsdom
// Wave 66 — with no current project, no feed is subscribed and no
// outbox/Dexie read happens; nothing ever falls back to "default-project".
import { describe, expect, it, vi } from "vitest";
import { render, renderHook } from "@testing-library/react";

const EMPTY_ROWS = vi.hoisted(() => [] as unknown[]);
const h = vi.hoisted(() => ({
  pid: undefined as string | undefined,
  watchTasks: vi.fn(() => () => {}),
  outboxWhere: vi.fn(() => ({ anyOf: () => ({ toArray: async () => [] }) })),
}));
const source = vi.hoisted(() => ({ watchTasks: h.watchTasks, overlaySending: false }));

vi.mock("@ff/auth", () => ({
  useAuthContext: () => ({ app: {}, isDemo: true }),
  useAuth: () => ({ user: null }),
  useProjectId: () => h.pid,
  requireProjectId: (id?: string) => {
    if (!id) throw new Error("No active project");
    return id;
  },
}));
vi.mock("@ff/data/db/database", () => ({ db: { outbox: { where: h.outboxWhere } } }));
vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => EMPTY_ROWS,
}));
vi.mock("../src/tasksSource", async (o) => ({
  ...(await o<typeof import("../src/tasksSource")>()),
  useTasksSource: () => source,
}));

import { usePanelTasks } from "../src/usePanelTasks";
import { queryActiveOutboxRows } from "../src/useOutboxRows";
import { TaskCalloutLayer2D } from "../src/TaskCalloutLayer2D";

describe("project scoping (wave 66)", () => {
  it("usePanelTasks subscribes with the current project id", () => {
    h.pid = "p1";
    h.watchTasks.mockClear();
    renderHook(() => usePanelTasks());
    expect(h.watchTasks).toHaveBeenCalledWith("p1", null, expect.any(Function), 100);
  });

  it("usePanelTasks does not subscribe without a project", () => {
    h.pid = undefined;
    h.watchTasks.mockClear();
    renderHook(() => usePanelTasks());
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("TaskCalloutLayer2D does not subscribe without a project", () => {
    h.pid = undefined;
    h.watchTasks.mockClear();
    render(<TaskCalloutLayer2D getSurface={() => null} pdfFileId="f" pageSize={{ width: 1, height: 1 }} />);
    expect(h.watchTasks).not.toHaveBeenCalled();
  });

  it("the outbox query reads nothing without a project", async () => {
    h.outboxWhere.mockClear();
    expect(await queryActiveOutboxRows(undefined)).toEqual([]);
    expect(h.outboxWhere).not.toHaveBeenCalled();
  });
});
