import { describe, expect, it } from "vitest";

import {
  filterTasks,
  initialPanelState,
  mergePanelTasks,
  panelBadgeState,
  resetPanel,
  scopeTasks,
  isPanelOverdue,
  type PanelTask,
} from "../src/panelLogic";

/**
 * Wave 9 · pure panel logic (spec §A). Scope (3D storey / 2D page /
 * no-location only-in-All), the four filter chips (incl. terminal
 * exclusion), the overdue-dot badge rule, and the reset semantics.
 */

function task(over: Partial<PanelTask> = {}): PanelTask {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 100,
    assigneeName: "Ana",
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

const NOW = 1_000_000;

describe("scopeTasks", () => {
  it("`all` returns every row unchanged (incl. no-location)", () => {
    const rows = [
      task({ id: "a", location: { storeyName: "L12" } }),
      task({ id: "b", location: { pdf: { page: 3 } } }),
      task({ id: "c" }), // no location
    ];
    expect(scopeTasks(rows, { scope: "all" }).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("in-view (3D) keeps only rows whose storeyName matches", () => {
    const rows = [
      task({ id: "a", location: { storeyName: "L12" } }),
      task({ id: "b", location: { storeyName: "L13" } }),
      task({ id: "c", location: { storeyName: null } }),
    ];
    expect(scopeTasks(rows, { scope: "inview", storeyName: "L12" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("in-view (2D) keeps only rows whose pdf.page matches", () => {
    const rows = [
      task({ id: "a", location: { pdf: { page: 3 } } }),
      task({ id: "b", location: { pdf: { page: 4 } } }),
      task({ id: "c", location: { storeyName: "L12" } }), // 3D-only anchor → excluded in 2D
    ];
    expect(scopeTasks(rows, { scope: "inview", pdfPage: 3 }).map((t) => t.id)).toEqual(["a"]);
  });

  it("tasks WITHOUT a location appear only in All, never in view", () => {
    const rows = [
      task({ id: "a", location: { storeyName: "L12" } }),
      task({ id: "b" }),
      task({ id: "c" }),
    ];
    expect(scopeTasks(rows, { scope: "inview", storeyName: "L12" }).map((t) => t.id)).toEqual(["a"]);
    expect(scopeTasks(rows, { scope: "all" }).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("no anchor (3D default whole-model view) → every BIM-pinned task is in view", () => {
    const rows = [
      task({ id: "a", location: { storeyName: "L12", bim: { worldPoint: [1, 2, 3] } } }),
      task({ id: "b", location: { pdf: { pdfFileId: "f", page: 1, uv: [0.5, 0.5] } } }),
      task({ id: "c" }),
    ];
    // a: pinned to the model → visible in the default view. b: a plan
    // pin — not rendered in 3D. c: no location → All only.
    expect(scopeTasks(rows, { scope: "inview" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("does not mutate the input array", () => {
    const rows = [task({ id: "a", location: { storeyName: "L12" } })];
    const copy = [...rows];
    scopeTasks(rows, { scope: "all" });
    expect(rows).toEqual(copy);
  });
});

describe("filterTasks", () => {
  const open = task({ id: "o", status: 10 }); // inbox (non-terminal)
  const ongoing = task({ id: "g", status: 20, deadline: NOW - 1, assigneeUid: "me" });
  const approved = task({ id: "ap", status: 65 }); // terminal
  const discontinued = task({ id: "di", status: 80 }); // terminal
  const rejected = task({ id: "rj", status: 30 }); // rejected: non-terminal, non-open status
  const mine = task({ id: "mi", status: 40, assigneeUid: "me" });
  const others = task({ id: "ot", status: 60, assigneeUid: "them" });

  const rows = [open, ongoing, approved, discontinued, rejected, mine, others];

  it("all = passthrough", () => {
    expect(filterTasks(rows, "all", { actorUid: "me", now: NOW })).toHaveLength(rows.length);
  });

  it("open = non-terminal (excludes 65/80 but keeps 10/20/30/40/60)", () => {
    const ids = filterTasks(rows, "open", { actorUid: "me", now: NOW }).map((t) => t.id);
    expect(ids.sort()).toEqual(["g", "mi", "o", "ot", "rj"]);
    expect(ids).not.toContain("ap");
    expect(ids).not.toContain("di");
  });

  it("overdue = isOverdue && non-terminal (a past-due terminal task is excluded)", () => {
    const pastDueTerminal = task({ id: "pt", status: 65, deadline: NOW - 10 });
    const pastDueOpen = task({ id: "po", status: 40, deadline: NOW - 10 });
    const futureOpen = task({ id: "fo", status: 40, deadline: NOW + 10 });
    const rows2 = [pastDueTerminal, pastDueOpen, futureOpen];
    expect(filterTasks(rows2, "overdue", { actorUid: "me", now: NOW }).map((t) => t.id)).toEqual(["po"]);
  });

  it("mine = assigneeUid === actorUid", () => {
    const ids = filterTasks(rows, "mine", { actorUid: "me", now: NOW }).map((t) => t.id);
    expect(ids.sort()).toEqual(["g", "mi"]);
  });

  it("mine ignores null/undefined assigneeUid", () => {
    const unassigned = task({ id: "u", status: 10, assigneeUid: null });
    expect(filterTasks([unassigned], "mine", { actorUid: "me", now: NOW })).toEqual([]);
  });
});

describe("panelBadgeState (overdue dot rule)", () => {
  it("count is the (already-scoped) row count", () => {
    expect(panelBadgeState([task(), task(), task()], NOW).count).toBe(3);
    expect(panelBadgeState([], NOW).count).toBe(0);
  });

  it("overdue flag is true when any row is past-due + non-terminal", () => {
    const ok = task({ id: "ok", status: 10 });
    const late = task({ id: "late", status: 20, deadline: NOW - 1 });
    expect(panelBadgeState([ok, late], NOW).overdue).toBe(true);
  });

  it("overdue flag is false when the only late row is terminal", () => {
    const doneLate = task({ id: "done", status: 65, deadline: NOW - 1 });
    expect(panelBadgeState([doneLate], NOW).overdue).toBe(false);
  });

  it("overdue flag is false when nothing is past-due", () => {
    expect(panelBadgeState([task({ status: 10 })], NOW).overdue).toBe(false);
  });
});

describe("isPanelOverdue", () => {
  it("true for past-due non-terminal, false otherwise", () => {
    expect(isPanelOverdue(task({ status: 20, deadline: NOW - 1 }), NOW)).toBe(true);
    expect(isPanelOverdue(task({ status: 65, deadline: NOW - 1 }), NOW)).toBe(false);
    expect(isPanelOverdue(task({ status: 20, deadline: NOW + 1 }), NOW)).toBe(false);
    expect(isPanelOverdue(task({ status: 20, deadline: null }), NOW)).toBe(false);
  });
});

describe("reset semantics (boss decision 5)", () => {
  it("initial state = In view · All · no selection", () => {
    expect(initialPanelState()).toEqual({ scope: "inview", chip: "all", selectedId: null });
  });

  it("resetPanel returns a FRESH object equal to the initial state", () => {
    const a = resetPanel();
    a.selectedId = "t1";
    a.scope = "all";
    expect(resetPanel()).toEqual({ scope: "inview", chip: "all", selectedId: null });
  });
});

describe("mergePanelTasks", () => {
  function outboxRow(over: Record<string, unknown> = {}): Parameters<typeof mergePanelTasks>[1][number] {
    return {
      id: "g1",
      kind: "task-action",
      state: "added",
      projectId: "p1",
      payload: {},
      photoRefs: [],
      attempts: 0,
      clientGuid: "g1",
      createdAt: 5,
      ...over,
    };
  }

  it("overlays a pending CREATE with its location preserved for scoping", () => {
    const merged = mergePanelTasks(
      [task({ id: "c1", num: 1 })],
      [
        outboxRow({
          payload: {
            verb: "create",
            taskId: "t9",
            title: "Honeycomb edge",
            statusTo: 10,
            createDoc: { num: 9, location: { storeyName: "L12" } },
          },
        }),
      ],
      false,
    );
    const pending = merged.find((t) => t.id === "t9");
    expect(pending).toBeTruthy();
    expect(pending?.title).toBe("Honeycomb edge");
    expect(pending?.location?.storeyName).toBe("L12");
    expect(pending?.pending).toBe(true);
  });

  it("does not overlay a `sending` row with overlaySending=false (cloud optimistic)", () => {
    const merged = mergePanelTasks(
      [task({ id: "c1" })],
      [
        outboxRow({
          state: "sending",
          payload: { verb: "create", taskId: "t9", title: "Sending", statusTo: 10 },
        }),
      ],
      false,
    );
    expect(merged.find((t) => t.id === "t9")).toBeUndefined();
  });

  it("overlays a `sending` row when overlaySending=true (demo)", () => {
    const merged = mergePanelTasks(
      [task({ id: "c1" })],
      [
        outboxRow({
          state: "sending",
          payload: { verb: "create", taskId: "t9", title: "Sending", statusTo: 10 },
        }),
      ],
      true,
    );
    expect(merged.find((t) => t.id === "t9")?.pending).toBe(true);
  });

  it("overlays a status update on an existing row", () => {
    const merged = mergePanelTasks(
      [task({ id: "c1", status: 10 })],
      [
        outboxRow({
          payload: { verb: "complete", taskId: "c1", statusTo: 40, at: 200 },
        }),
      ],
      false,
    );
    const row = merged.find((t) => t.id === "c1");
    expect(row?.status).toBe(40);
    expect(row?.pending).toBe(true);
  });
});