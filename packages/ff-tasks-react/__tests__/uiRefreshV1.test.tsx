// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { mergeTaskViews, type TaskView } from "@ff/tasks";

import {
  SAVED_VIEWS,
  deadlineIsOverdue,
  formatTaskNum,
  groupTasks,
  initialsOf,
  quickAdvanceVerb,
  relativeDeadlineLabel,
  scopeRowsToBuilding,
} from "../src/logic";
import { buildComposeEnqueues, draftToCompose, emptyCompose, toDraftFields } from "../src/composeModel";
import { TaskBoardPanel, boardColumnFor, BOARD_COLUMNS } from "../src/TaskBoardPanel";
import { TaskTablePanel } from "../src/TaskTablePanel";
import { TaskComposeSheet } from "../src/TaskComposeSheet";
import { TasksApp } from "../src/TasksApp";
import type { TaskTableRow } from "../src/tableColumns";

// ── wave 53 stacking seam · module mocks (the heavy data layer is fully
// replaced so <TasksApp> can mount with zero Firebase/Dexie). Every mock
// preserves `...actual` where an existing seam test re-uses the real
// export (e.g. mergeTaskViews). ──────────────────────────────────────────

const tasksAppMocks = vi.hoisted(() => {
  const state: { seedTasks: TaskView[]; maxCalls: number[] } = { seedTasks: [], maxCalls: [] };
  const source = {
    overlaySending: false,
    watchTasks: (_pid: string, _statuses: unknown, cb: (tasks: TaskView[]) => void, max?: number) => {
      state.maxCalls.push(max ?? -1);
      cb(state.seedTasks);
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

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => [],
}));

vi.mock("../src/useTaskEngine", () => ({
  draftTable: {
    get: async () => undefined,
    put: async () => {},
    delete: async () => {},
    whereProject: async () => [],
  },
  useTaskEngine: () => ({
    enqueue: async () => {},
    retryNow: async () => {},
    remove: async () => {},
  }),
  registerBlob: () => {},
  releaseBlob: () => {},
}));

vi.mock("../src/useTaskPeople", () => ({
  useTaskPeople: () => ({
    actor: { uid: "u1", name: "Ana" },
    members: [],
    ensureMembers: async () => {},
  }),
}));

vi.mock("../src/tasksSource", () => ({
  useTasksSource: () => tasksAppMocks.source,
  useTasksFirestore: () => null,
  makeTaskPhotoResolver: () => undefined,
  DEMO_PEOPLE: [],
}));

vi.mock("../src/photoResolver", () => ({
  useTaskPhotoResolver: () => undefined,
}));

/**
 * UI refresh v1 acceptance seams (docs/ux/tasks-ui-refresh-v1.md §6):
 * buildingId round-trip, scope filter, relative-deadline formatter,
 * group helpers, board column map + tap path, compose inheritance.
 */

const DAY = 86_400_000;
const NOW = new Date("2026-11-08T12:00:00").getTime();

function task(over: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: NOW,
    assigneeName: "Ana Silva",
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

// ── §6.1 buildingId round-trip: compose → outbox payload → merge ────────

describe("buildingId round-trip (compose → outbox → merge)", () => {
  it("compose enqueues carry buildingId in the create doc", () => {
    const fields = { ...emptyCompose(), title: "Scoped", buildingId: "b-7" };
    const [create] = buildComposeEnqueues(fields, {
      projectId: "p1",
      taskId: "g1",
      actor: { uid: "u1", name: "Ana" },
      at: NOW,
    });
    expect(create.createDoc?.buildingId).toBe("b-7");
  });

  it("null buildingId stays null (cross-building)", () => {
    const fields = { ...emptyCompose(), title: "Legacy", buildingId: null };
    const [create] = buildComposeEnqueues(fields, {
      projectId: "p1",
      taskId: "g2",
      actor: { uid: "u1", name: "Ana" },
      at: NOW,
    });
    expect(create.createDoc?.buildingId).toBeNull();
  });

  it("a queued create merges into the view with its buildingId", () => {
    const fields = { ...emptyCompose(), title: "Queued scoped", buildingId: "b-3" };
    const [create] = buildComposeEnqueues(fields, {
      projectId: "p1",
      taskId: "g3",
      actor: { uid: "u1", name: "Ana" },
      at: NOW,
    });
    const row = {
      id: "r1",
      kind: "task-action" as const,
      state: "added" as const,
      projectId: "p1",
      payload: create as unknown as Record<string, unknown>,
      photoRefs: [],
      attempts: 0,
      clientGuid: create.clientGuid,
      createdAt: NOW,
    };
    const out = mergeTaskViews([], [row as never]);
    expect(out.find((t) => t.id === "g3")?.buildingId).toBe("b-3");
  });
});

// ── §6.1/§6.2 scope filter ───────────────────────────────────────────────

describe("scopeRowsToBuilding", () => {
  const rows = [
    task({ id: "a", buildingId: "b1" }),
    task({ id: "b", buildingId: null }),
    task({ id: "c" }), // legacy: field absent
    task({ id: "d", buildingId: "b2" }),
  ];

  it("building scope keeps that building + null/absent rows (never orphaned)", () => {
    expect(scopeRowsToBuilding(rows, "b1", "building").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("all scope restores every row", () => {
    expect(scopeRowsToBuilding(rows, "b1", "all").map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("no active building = everything passes even in building scope", () => {
    expect(scopeRowsToBuilding(rows, null, "building")).toHaveLength(4);
  });
});

// ── §6 V6 relative-deadline formatter ────────────────────────────────────

describe("relativeDeadlineLabel", () => {
  it("today / tomorrow / in Nd", () => {
    expect(relativeDeadlineLabel(NOW, NOW)?.label).toBe("Today");
    expect(relativeDeadlineLabel(NOW + DAY, NOW)?.label).toBe("Tomorrow");
    expect(relativeDeadlineLabel(NOW + 3 * DAY, NOW)?.label).toBe("in 3d");
  });

  it("late labels + overdue flag", () => {
    expect(relativeDeadlineLabel(NOW - DAY, NOW)).toEqual({ label: "1d late", overdue: true });
    expect(relativeDeadlineLabel(NOW - 3 * DAY, NOW)).toEqual({ label: "3d late", overdue: true });
  });

  it("far future falls back to the absolute date (null)", () => {
    expect(relativeDeadlineLabel(NOW + 30 * DAY, NOW)).toBeNull();
    expect(relativeDeadlineLabel(null, NOW)).toBeNull();
  });

  it("deadlineIsOverdue honors terminal statuses (65/80 quiet)", () => {
    expect(deadlineIsOverdue(NOW - DAY, 20, NOW)).toBe(true);
    expect(deadlineIsOverdue(NOW - DAY, 65, NOW)).toBe(false);
    expect(deadlineIsOverdue(NOW - DAY, 80, NOW)).toBe(false);
  });
});

// ── §3 V4 group helpers ──────────────────────────────────────────────────

describe("groupTasks", () => {
  const rows = [
    task({ id: "x", status: 40, buildingId: "b2", buildingName: "North Tower", assigneeName: "Ana Silva" }),
    task({ id: "y", status: 10, buildingId: null, assigneeName: "Ana Silva" }),
    task({ id: "z", status: 20, buildingId: "b1", buildingName: "East Wing", assigneeName: null }),
  ];

  it("status groups sort by workflow order", () => {
    const g = groupTasks(rows, "status");
    expect(g.map((x) => x.label)).toEqual(["Inbox", "Ongoing", "Awaiting approval"]);
    expect(g[0]!.rows.map((r) => r.id)).toEqual(["y"]);
  });

  it("building groups label by name; legacy renders '—' and stays present", () => {
    const g = groupTasks(rows, "building");
    expect(g.map((x) => x.label)).toEqual(["East Wing", "North Tower", "—"]);
  });

  it("assignee groups push unassigned last", () => {
    const g = groupTasks(rows, "assignee");
    expect(g.map((x) => x.label)).toEqual(["Ana Silva", "Unassigned"]);
  });

  it("none = flat (no groups)", () => {
    expect(groupTasks(rows, "none")).toEqual([]);
  });

  it("initialsOf: two words → JK, one word → AB", () => {
    expect(initialsOf("Ana Silva")).toBe("AS");
    expect(initialsOf("boss")).toBe("BO");
    expect(initialsOf(null)).toBe("?");
  });
});

// ── §6.4 board view ──────────────────────────────────────────────────────

describe("TaskBoardPanel", () => {
  it("columns map 1:1 onto the status set (10/20/40/60/terminal)", () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual(["10", "20", "40", "60", "terminal"]);
    expect(boardColumnFor(30).key).toBe("terminal");
    expect(boardColumnFor(65).key).toBe("terminal");
    expect(boardColumnFor(10).key).toBe("10");
  });

  it("cards land in the status column; tap fires onOpen with the row", () => {
    const onOpen = vi.fn();
    const t = task({ id: "boardy", status: 40, num: 12 });
    render(<TaskBoardPanel rows={[t]} now={NOW} onOpen={onOpen} />);
    const card = screen.getByTestId("board-card-boardy");
    expect(card.textContent).toContain(formatTaskNum(12));
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect((onOpen.mock.calls[0] as [TaskView])[0].id).toBe("boardy");
  });

  it("renders the relative deadline on the card", () => {
    render(<TaskBoardPanel rows={[task({ id: "dl", deadline: NOW + DAY })]} now={NOW} />);
    expect(screen.getByTestId("board-card-dl").textContent).toContain("Tomorrow");
  });
});

// ── §6.3 table group headers + hover actions ─────────────────────────────

describe("TaskTablePanel — group headers + hover actions", () => {
  it("groupBy status renders group header rows with counts; collapse hides that group's rows", () => {
    const rows = [task({ id: "g1", status: 20, title: "Collapsible title" }), task({ id: "g2", status: 10, title: "Other group" })];
    render(<TaskTablePanel rows={rows} now={0} groupBy="status" />);
    const header = screen.getByTestId("group-header-20").querySelector("td")!;
    expect(header.textContent).toContain("Ongoing");
    expect(header.textContent).toContain("1");
    expect(screen.getByText("Collapsible title")).toBeTruthy();
    fireEvent.click(header);
    expect(screen.queryByText("Collapsible title")).toBeNull();
    expect(screen.getByText("Other group")).toBeTruthy(); // other groups untouched
    fireEvent.click(header);
    expect(screen.getByText("Collapsible title")).toBeTruthy(); // expand restores
  });

  it("hover reveals ⌖/✓/⋯ and quick-advance fires with the computed verb", () => {
    const onLocate = vi.fn();
    const onQuickAdvance = vi.fn();
    const t = task({ id: "hov", status: 20, title: "Hover row" });
    render(
      <TaskTablePanel
        rows={[t]}
        now={0}
        onOpen={vi.fn()}
        onLocate={onLocate}
        onQuickAdvance={onQuickAdvance}
      />
    );
    fireEvent.mouseEnter(screen.getByLabelText("Hover row"));
    fireEvent.click(screen.getByLabelText("Locate Hover row in viewer"));
    expect(onLocate).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Quick complete/));
    expect(onQuickAdvance).toHaveBeenCalledWith(expect.objectContaining({ id: "hov" }), "complete");
  });

  it("building column shows the enriched name; legacy shows '—'", () => {
    const rows = [
      task({ id: "bn", buildingId: "b1", buildingName: "North Tower", title: "Named" }),
      task({ id: "bl", buildingId: null, title: "Legacy" }),
    ];
    const { container } = render(<TaskTablePanel rows={rows} now={0} />);
    const cells = [...container.querySelectorAll("td")];
    const text = container.textContent ?? "";
    expect(text).toContain("North Tower");
    expect(cells.length).toBeGreaterThan(0);
    expect(text).toContain("—");
  });
});

// ── quickAdvanceVerb ─────────────────────────────────────────────────────

describe("quickAdvanceVerb", () => {
  it("20/60 → complete, 40 → approve, terminals/10 → none", () => {
    expect(quickAdvanceVerb(20)).toBe("complete");
    expect(quickAdvanceVerb(60)).toBe("complete");
    expect(quickAdvanceVerb(40)).toBe("approve");
    expect(quickAdvanceVerb(10)).toBeNull();
    expect(quickAdvanceVerb(65)).toBeNull();
    expect(quickAdvanceVerb(80)).toBeNull();
  });
});

// ── §6.5 compose inherits the active building ────────────────────────────

describe("TaskComposeSheet — building inheritance + override", () => {
  const baseProps = {
    projectId: "p1",
    taskId: "tid",
    actor: { uid: "u1", name: "Ana" },
    members: [],
    // minimal fake engine/draftTable: the sheet only enqueues on submit
    engine: { enqueue: vi.fn(async () => {}), retryNow: vi.fn(async () => {}), remove: vi.fn(async () => {}) } as never,
  onDone: () => {},
  onClose: () => {},
    draftTable: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
      whereProject: async () => [],
    } as never,
  };

  it("inherits the rail building (chip selected)", () => {
    render(
      <TaskComposeSheet
        {...baseProps}
        buildingId="b1"
        buildings={[{ id: "b1", name: "North Tower" }, { id: "b2", name: "East Wing" }]}
      />
    );
    expect(screen.getByTestId("compose-building-b1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("compose-building-b2").getAttribute("aria-pressed")).toBe("false");
  });

  it("override switches the selected chip", () => {
    render(
      <TaskComposeSheet
        {...baseProps}
        buildingId="b1"
        buildings={[{ id: "b1", name: "North Tower" }, { id: "b2", name: "East Wing" }]}
      />
    );
    fireEvent.click(screen.getByTestId("compose-building-b2"));
    expect(screen.getByTestId("compose-building-b2").getAttribute("aria-pressed")).toBe("true");
  });

  it(">4 buildings renders the native picker", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, name: `B${i}` }));
    render(<TaskComposeSheet {...baseProps} buildingId="b0" buildings={many} />);
    expect(screen.getByTestId("compose-building-select")).toBeTruthy();
  });

  it("draft restore keeps the overridden building (initial wins)", () => {
    render(
      <TaskComposeSheet
        {...baseProps}
        buildingId="b1"
        initial={{ title: "R", buildingId: "b2" }}
        buildings={[{ id: "b1", name: "North Tower" }, { id: "b2", name: "East Wing" }]}
      />
    );
    expect(screen.getByTestId("compose-building-b2").getAttribute("aria-pressed")).toBe("true");
  });

  it("the override persists into the draft (toDraftFields → draftToCompose round-trip)", () => {
    const fields = { ...emptyCompose(), title: "Scoped draft", buildingId: "b-4" };
    const draft = toDraftFields(fields, "p1", "tid");
    expect(draft.buildingId).toBe("b-4");
    expect(draftToCompose(draft).buildingId).toBe("b-4");
    const legacy = { ...emptyCompose(), buildingId: undefined };
    expect(toDraftFields(legacy, "p1", "tid").buildingId).toBeNull();
  });
});

// ── §6.6 mobile meta line ────────────────────────────────────────────────

import { TasksListPanel } from "../src/TasksListPanel";

describe("TasksListPanel — refreshed mobile card meta", () => {
  it("shows the building · storey meta line + relative deadline", () => {
    render(
      <TasksListPanel
        rows={[task({ id: "m1", buildingId: "b1", buildingName: "North Tower", storeyName: "L3", deadline: NOW + DAY, title: "Mobile row" })]}
        now={NOW}
      />
    );
    expect(screen.getByTestId("ff-task-row-meta").textContent).toBe("North Tower · L3");
    expect(screen.getByText("Tomorrow")).toBeTruthy();
    expect(screen.getByText("Ongoing")).toBeTruthy(); // soft label next to the dot
  });

  it("legacy row: no meta line, still renders (never orphaned)", () => {
    render(<TasksListPanel rows={[task({ id: "m2", title: "Legacy mobile" })]} now={NOW} />);
    expect(screen.queryByTestId("ff-task-row-meta")).toBeNull();
    expect(screen.getByText("Legacy mobile")).toBeTruthy();
  });
});

describe("saved views registry", () => {
  it("carries the four boss-named presets", () => {
    expect(SAVED_VIEWS.map((v) => v.label)).toEqual(["My tasks", "Overdue", "This building", "All"]);
  });
});

// ── wave 53 · compose/detail stacking (TasksApp seam #1) ────────────────

describe("TasksApp — compose/detail stacking (wave 53)", () => {
  it("open detail → open compose → detail gone; open compose → open detail → compose gone", () => {
    tasksAppMocks.state.seedTasks = [task({ id: "t-stack", title: "Set door frame", num: 12 })];
    const { container } = render(<TasksApp />);

    const composeEl = () => container.querySelector(".ff-task-compose");
    const detailEl = () => container.querySelector(".ff-task-detail");

    // neither sheet open on mount
    expect(composeEl()).toBeNull();
    expect(detailEl()).toBeNull();

    // open a detail from the table row
    fireEvent.click(screen.getByLabelText("Set door frame"));
    expect(detailEl()).not.toBeNull();
    expect(composeEl()).toBeNull();

    // open compose → the open detail closes
    fireEvent.click(container.querySelector("button.ff-task-new") as HTMLButtonElement);
    expect(composeEl()).not.toBeNull();
    expect(detailEl()).toBeNull();

    // open the detail again → compose closes
    fireEvent.click(screen.getByLabelText("Set door frame"));
    expect(detailEl()).not.toBeNull();
    expect(composeEl()).toBeNull();
  });
});

describe("TasksApp — board honours column filters (w68)", () => {
  it("a table column filter also filters the board; Clear filters shows in board; Columns hides", () => {
    tasksAppMocks.state.seedTasks = [
      task({ id: "keep", title: "Keep me", num: 1, status: 20 }),
      task({ id: "drop", title: "Drop me", num: 2, status: 40 }),
    ];
    const { container } = render(<TasksApp />);
    fireEvent.click(screen.getByTestId("filter-funnel-status"));
    fireEvent.click(screen.getByLabelText("Ongoing"));
    fireEvent.click(screen.getByTestId("view-tab-board"));
    expect(screen.queryByTestId("board-card-keep")).not.toBeNull();
    expect(screen.queryByTestId("board-card-drop")).toBeNull();
    expect(container.querySelector(".ff-task-columns-button")).toBeNull();
    const clear = container.querySelector(".ff-task-clear-filters") as HTMLButtonElement;
    expect(clear.textContent).toContain("(1)");
    fireEvent.click(clear);
    expect(screen.queryByTestId("board-card-drop")).not.toBeNull();
  });
});

describe("TasksApp — server paging (w69, replaces the silent 50-row cap)", () => {
  it("offers Load more when the page is full, widening the live query; silent otherwise", () => {
    tasksAppMocks.state.maxCalls = [];
    tasksAppMocks.state.seedTasks = Array.from({ length: 3 }, (_, i) => task({ id: `n${i}`, title: `T ${i}`, num: i + 1 }));
    const { container, unmount } = render(<TasksApp limit={3} />);
    expect(container.querySelector(".ff-task-limit-note")).toBeNull(); // the old cap note is gone
    const more = screen.getByTestId("load-more");
    expect(screen.getByTestId("table-count").textContent).toBe("Showing 3 of 3+ tasks");
    fireEvent.click(more);
    expect(tasksAppMocks.state.maxCalls).toContain(6); // limit × pages
    unmount();
    const r2 = render(<TasksApp limit={50} />);
    expect(r2.queryByTestId("load-more")).toBeNull();
    expect(r2.getByTestId("table-count").textContent).toBe("Showing 3 of 3 tasks");
  });
});
