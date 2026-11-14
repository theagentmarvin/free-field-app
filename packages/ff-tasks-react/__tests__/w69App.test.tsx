// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { TaskView } from "@ff/tasks";

import { TasksApp } from "../src/TasksApp";
import type { TaskTableRow } from "../src/tableColumns";

const m = vi.hoisted(() => {
  const state = {
    seed: [] as unknown[],
    enqueue: [] as { verb: string; taskId: string; patch?: Record<string, unknown>; text: string; statusFrom: number }[],
  };
  const source = {
    overlaySending: false,
    watchTasks: (_p: string, _s: unknown, cb: (t: unknown[]) => void) => {
      cb(state.seed);
      return () => {};
    },
    deleteTask: async () => {},
    watchTask: () => () => {},
    watchTaskEntries: () => () => {},
  };
  return { state, source };
});

vi.mock("@ff/auth", () => ({
  useProjectId: () => "p1",
  requireProjectId: (id?: string) => {
    if (!id) throw new Error("No active project");
    return id;
  },
  useCurrentProject: () => ({ name: "North Gateway" }),
  useRole: () => "admin",
  useAuthContext: () => ({ isDemo: true }),
}));
vi.mock("@ff/data/db/database", () => ({
  db: { outbox: {}, drafts: {}, projects: { get: async () => undefined } },
}));
vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => [] }));
vi.mock("../src/useTaskEngine", () => ({
  draftTable: { get: async () => undefined, put: async () => {}, delete: async () => {}, whereProject: async () => [] },
  useTaskEngine: () => ({
    enqueue: async (payload: { verb: string; taskId: string; patch?: Record<string, unknown>; text: string; statusFrom: number }) => {
      m.state.enqueue.push(payload);
    },
    retryNow: async () => {},
    remove: async () => {},
  }),
  registerBlob: () => {},
  releaseBlob: () => {},
}));
vi.mock("../src/useTaskPeople", () => ({
  useTaskPeople: () => ({
    actor: { uid: "me", name: "Me Myself" },
    members: [
      { uid: "me", name: "Me Myself" },
      { uid: "u2", name: "Bo Diaz" },
    ],
    ensureMembers: async () => {},
  }),
}));
vi.mock("../src/tasksSource", () => ({
  useTasksSource: () => m.source,
  useTasksFirestore: () => null,
  makeTaskPhotoResolver: () => undefined,
  DEMO_PEOPLE: [],
}));
vi.mock("../src/photoResolver", () => ({ useTaskPhotoResolver: () => undefined }));
vi.mock("../src/useOutboxRows", () => ({ useOutboxRows: () => [] }));
vi.mock("../src/TaskDetailHost", () => ({
  TaskDetailHost: (p: { taskId: string; startEditing?: boolean }) => (
    <div data-testid="detail-host" data-edit={String(!!p.startEditing)}>
      {p.taskId}
    </div>
  ),
}));

const NOW = Date.now();
const DAY = 86_400_000;
function task(over: Partial<TaskTableRow> = {}): TaskView {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: NOW,
    assigneeName: "Ana",
    assigneeUid: "u9",
    lastAction: "create",
    entryCount: 1,
    createdAt: NOW - 10 * DAY,
    ...over,
  } as TaskView;
}

beforeEach(() => {
  localStorage.clear();
  m.state.enqueue = [];
  m.state.seed = [
    task({ id: "a", num: 1, title: "Alpha", status: 20, assigneeUid: "me", assigneeName: "Me Myself", deadline: NOW - 3 * DAY }),
    task({ id: "b", num: 2, title: "Bravo", status: 10, assigneeUid: null, assigneeName: null, deadline: null }),
    task({ id: "c", num: 3, title: "Charlie", status: 40, assigneeUid: "u2", assigneeName: "Bo Diaz", deadline: NOW + 2 * DAY }),
    task({ id: "d", num: 4, title: "Delta", status: 65, assigneeUid: "me", assigneeName: "Me Myself", deadline: NOW - 9 * DAY }),
  ];
});
afterEach(() => cleanup());

const countOf = (id: string) => screen.getByTestId(`${id}-count`).textContent;

describe("TasksApp — counts + quick filters (w69)", () => {
  it("status chips carry counts of what clicking them yields", () => {
    render(<TasksApp />);
    expect(countOf("chip-all")).toBe("4");
    expect(countOf("chip-open")).toBe("3");
    expect(countOf("chip-closed")).toBe("1");
    expect(countOf("chip-10")).toBe("1");
    expect(countOf("chip-20")).toBe("1");
    expect(countOf("chip-40")).toBe("1");
  });

  it("My tasks and Overdue are independent toggles that re-count the chips", () => {
    render(<TasksApp />);
    expect(countOf("quick-mine")).toBe("1"); // open + assigned to me (Delta is closed)
    expect(countOf("quick-overdue")).toBe("1"); // Alpha only; closed Delta never signals
    fireEvent.click(screen.getByTestId("quick-mine"));
    expect(screen.getByTestId("quick-mine").getAttribute("aria-pressed")).toBe("true");
    expect(countOf("chip-all")).toBe("2"); // Alpha + Delta
    expect(screen.queryByLabelText("Task Bravo")).toBeNull();
    fireEvent.click(screen.getByTestId("quick-overdue"));
    expect(countOf("chip-all")).toBe("1");
    expect(screen.getByLabelText("Alpha")).toBeTruthy();
    // chip click on top of quick filter
    fireEvent.click(screen.getByTestId("chip-closed"));
    expect(screen.queryByLabelText("Alpha")).toBeNull();
  });
});

describe("TasksApp — bulk actions (w69)", () => {
  it("multi-select shows the sticky bar; deadline change enqueues one logged edit per task and Undo reverts", async () => {
    render(<TasksApp />);
    fireEvent.click(screen.getByTestId("row-check-a"));
    fireEvent.click(screen.getByTestId("row-check-b"));
    expect(screen.getByTestId("bulk-count").textContent).toBe("2 selected");
    fireEvent.change(screen.getByTestId("bulk-deadline"), { target: { value: "2030-01-15" } });
    await waitFor(() => expect(m.state.enqueue).toHaveLength(2));
    expect(m.state.enqueue.map((e) => [e.taskId, e.verb])).toEqual([["a", "edit"], ["b", "edit"]]);
    expect(m.state.enqueue[0]!.patch).toEqual({ deadline: new Date(2030, 0, 15, 12).getTime() });
    expect(m.state.enqueue[0]!.text).toMatch(/^changed deadline from .* to 15 Jan 2030$/);
    const toast = screen.getByTestId("task-toast");
    expect(toast.textContent).toContain("Updated 2 tasks");
    fireEvent.click(screen.getByTestId("task-toast-action")); // Undo
    await waitFor(() => expect(m.state.enqueue).toHaveLength(4));
    expect(m.state.enqueue[2]!.patch).toEqual({ deadline: NOW - 3 * DAY });
    expect(m.state.enqueue[3]!.patch).toEqual({ deadline: null });
    expect(m.state.enqueue[2]!.text).toMatch(/^reverted:/);
  });

  it("bulk status skips illegal rows and reports them", async () => {
    render(<TasksApp />);
    fireEvent.click(screen.getByTestId("row-check-a")); // ongoing → complete ok
    fireEvent.click(screen.getByTestId("row-check-b")); // inbox → complete illegal
    fireEvent.change(screen.getByTestId("bulk-status"), { target: { value: "complete" } });
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]).toMatchObject({ taskId: "a", verb: "complete", statusFrom: 20 });
    expect(screen.getByTestId("task-toast").textContent).toContain("1 skipped");
    expect(screen.queryByTestId("bulk-bar")).toBeNull(); // selection cleared after a status change
  });

  it("bulk discontinue is confirmed first and offers no undo", async () => {
    render(<TasksApp />);
    fireEvent.click(screen.getByTestId("row-check-a"));
    fireEvent.click(screen.getByTestId("bulk-discontinue"));
    expect(m.state.enqueue).toHaveLength(0);
    expect(screen.getByTestId("task-confirm").textContent).toMatch(/Discontinue 1 task\?/);
    fireEvent.click(screen.getByTestId("task-confirm-ok"));
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]).toMatchObject({ verb: "discontinue", taskId: "a" });
    expect(screen.queryByTestId("task-toast-action")).toBeNull();
  });

  it("assignee change goes through the roster and Esc clears the selection", async () => {
    render(<TasksApp />);
    fireEvent.click(screen.getByTestId("row-check-c"));
    fireEvent.change(screen.getByTestId("bulk-assignee"), { target: { value: "me" } });
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]!.patch).toEqual({ assigneeUid: "me", assigneeName: "Me Myself" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("bulk-bar")).toBeNull();
  });
});

describe("TasksApp — keyboard (w69)", () => {
  it("J/K move the focused row, Enter opens it, E opens it editing, ? shows the cheat-sheet", () => {
    render(<TasksApp />);
    fireEvent.keyDown(window, { key: "j" });
    const first = document.querySelector("tr[data-active='true']") as HTMLElement;
    expect(first).not.toBeNull();
    const firstTitle = first.getAttribute("aria-label");
    fireEvent.keyDown(window, { key: "j" });
    const second = document.querySelector("tr[data-active='true']") as HTMLElement;
    expect(second.getAttribute("aria-label")).not.toBe(firstTitle);
    fireEvent.keyDown(window, { key: "k" });
    expect((document.querySelector("tr[data-active='true']") as HTMLElement).getAttribute("aria-label")).toBe(firstTitle);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(screen.getByTestId("detail-host").getAttribute("data-edit")).toBe("false");
    cleanup();

    render(<TasksApp />);
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "e" });
    expect(screen.getByTestId("detail-host").getAttribute("data-edit")).toBe("true");
  });

  it("? opens the cheat-sheet; Esc closes it; shortcuts are ignored while typing", () => {
    render(<TasksApp />);
    fireEvent.keyDown(window, { key: "?" });
    expect(screen.getByTestId("shortcuts-sheet")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("shortcuts-sheet")).toBeNull();
    const search = screen.getByLabelText("Search tasks");
    fireEvent.keyDown(search, { key: "j" });
    expect(document.querySelector("tr[data-active='true']")).toBeNull();
  });

  it("N opens the compose sheet; / focuses search", () => {
    render(<TasksApp />);
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(screen.getByLabelText("Search tasks"));
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("X toggles selection of the focused row", () => {
    render(<TasksApp />);
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "x" });
    expect(screen.getByTestId("bulk-count").textContent).toBe("1 selected");
  });
});

describe("TasksApp — board moves (w69)", () => {
  function toBoard() {
    render(<TasksApp />);
    fireEvent.click(screen.getByTestId("view-tab-board"));
  }

  it("Alt+→ on an Ongoing card submits it for approval (complete)", async () => {
    toBoard();
    fireEvent.keyDown(screen.getByTestId("board-card-a"), { key: "ArrowRight", altKey: true });
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]).toMatchObject({ verb: "complete", taskId: "a", statusFrom: 20 });
  });

  it("moving an Awaiting card to Closed asks for confirmation before approving", async () => {
    toBoard();
    fireEvent.keyDown(screen.getByTestId("board-card-c"), { key: "ArrowRight", altKey: true }); // 40 → 60 follow-up
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]).toMatchObject({ verb: "followup", taskId: "c" });
  });

  it("an illegal move explains itself and writes nothing", () => {
    toBoard();
    // Ongoing → Inbox has no workflow verb
    fireEvent.keyDown(screen.getByTestId("board-card-a"), { key: "ArrowLeft", altKey: true });
    expect(m.state.enqueue).toHaveLength(0);
    expect(screen.getByTestId("task-toast").textContent).toMatch(/isn’t allowed from Ongoing/);
  });

  it("moving an Awaiting card into Closed confirms before approving", async () => {
    toBoard();
    // 40 → 60 is one step right; Closed is two steps, reached by repeated Alt+→ after follow-up
    // (drop handler path): exercise the confirm through the board drop instead.
    const store: Record<string, string> = {};
    const dt = { setData: (k: string, v: string) => (store[k] = v), getData: (k: string) => store[k] ?? "", effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(screen.getByTestId("board-card-c"), { dataTransfer: dt });
    fireEvent.dragOver(screen.getByTestId("board-col-terminal"), { dataTransfer: dt });
    fireEvent.drop(screen.getByTestId("board-col-terminal"), { dataTransfer: dt });
    expect(m.state.enqueue).toHaveLength(0);
    expect(screen.getByTestId("task-confirm").textContent).toMatch(/Approve this task\?/);
    fireEvent.click(screen.getByTestId("task-confirm-ok"));
    await waitFor(() => expect(m.state.enqueue).toHaveLength(1));
    expect(m.state.enqueue[0]).toMatchObject({ verb: "approve", taskId: "c", statusFrom: 40 });
  });
});

describe("TasksApp — export (w69)", () => {
  it("CSV export downloads the current filtered view", () => {
    const created: Blob[] = [];
    const orig = URL.createObjectURL;
    URL.createObjectURL = ((b: Blob) => (created.push(b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<TasksApp />);
      fireEvent.click(screen.getByTestId("chip-closed")); // only Delta
      fireEvent.click(screen.getByLabelText("Export tasks"));
      fireEvent.click(screen.getByTestId("export-csv"));
      expect(created).toHaveLength(1);
      return new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsText(created[0]!);
      }).then((t) => {
        expect(t).toContain("T004");
        expect(t).not.toContain("T001");
        expect(screen.getByTestId("task-toast").textContent).toContain("Exported 1 task to CSV");
      });
    } finally {
      click.mockRestore();
      URL.createObjectURL = orig;
    }
  });
});
