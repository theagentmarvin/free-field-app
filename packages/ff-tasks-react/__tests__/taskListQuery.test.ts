import { describe, expect, it } from "vitest";
import type { TaskView } from "@ff/tasks";

import { applyColumnFilters, type ActiveFilters } from "../src/columnFilters";
import { SAVED_VIEWS, applyQuickFilters, chipCounts, matchesChip, scopeRowsToBuilding, visibleTasks } from "../src/logic";
import { enrichTaskRow, minuteOf, selectTaskList, type TaskListQuery } from "../src/taskListQuery";
import { EMPTY_TASK_BUILDING_INDEX, withEffectiveBuilding } from "../src/taskBuilding";

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 86_400_000;
const mk = (o: Partial<TaskView> & { id: string; status: number }): TaskView =>
  ({ num: 1, title: "t", updatedAt: 1, assigneeName: null, lastAction: "create", entryCount: 1, ...o }) as TaskView;

const T: TaskView[] = [
  mk({ id: "a", num: 1, status: 10, title: "Cracked wall", updatedAt: 5, assigneeUid: "me", assigneeName: "Me", buildingId: "b1", deadline: NOW - DAY }),
  mk({ id: "b", num: 2, status: 20, title: "Leaking pipe", updatedAt: 9, assigneeUid: "bob", assigneeName: "Bob", buildingId: "b2", deadline: NOW + DAY }),
  mk({ id: "c", num: 3, status: 40, title: "Door RFI", updatedAt: 7, assigneeUid: "me", assigneeName: "Me", buildingId: "b1", deadline: NOW + 20 * DAY }),
  mk({ id: "d", num: 4, status: 65, title: "Done thing", updatedAt: 3, assigneeUid: "me", assigneeName: "Me", buildingId: null }),
  mk({ id: "e", num: 5, status: 80, title: "Dropped", updatedAt: 1, buildingId: "b2" }),
  mk({ id: "f", num: 6, status: 60, title: "Follow up", updatedAt: 2, assigneeUid: "bob", assigneeName: "Bob", buildingId: "b1", priority: "high" as never }),
];
const names = new Map([["b1", "North"], ["b2", "South"]]);

const base: TaskListQuery = {
  chip: "all", search: "", sort: "updated", view: null, scope: "all", buildingId: null, quick: {}, columnFilters: {},
  uid: "me", now: NOW, buildingIndex: EMPTY_TASK_BUILDING_INDEX, buildingNames: names,
};

/** The web's composition, written out step by step exactly as <TasksApp> ran it before the shared function existed. */
function webReference(q: TaskListQuery) {
  const view = q.view;
  const merged = visibleTasks(T, [], {
    chip: "all", search: q.search, sort: q.sort, limit: Number.POSITIVE_INFINITY,
    assigneeUid: view?.apply.myTasks ? q.uid : undefined, overdueOnly: view?.apply.overdueOnly, overdueNow: q.now,
  });
  const pre = scopeRowsToBuilding(withEffectiveBuilding(merged, q.buildingIndex), q.buildingId, q.scope);
  const quick = applyQuickFilters(pre, q.quick, q.uid, q.now);
  const scoped = quick.filter((t) => matchesChip(t.status, q.chip));
  const rows = scoped.map((t) => ({ ...t, buildingName: t.buildingId ? (names.get(t.buildingId) ?? null) : null, storeyName: null }));
  return { counts: chipCounts(quick), ids: applyColumnFilters(rows as never, q.columnFilters, q.now).map((r) => r.id) };
}

describe("selectTaskList = the web pipeline", () => {
  const cases: Array<[string, Partial<TaskListQuery>]> = [
    ["default", {}],
    ["open chip", { chip: "open" }],
    ["exact status chip", { chip: 40 }],
    ["closed chip + search", { chip: "closed", search: "done" }],
    ["search by number and assignee", { search: "t002" }],
    ["sort deadline", { sort: "deadline" }],
    ["sort created", { sort: "created" }],
    ["My tasks view", { view: SAVED_VIEWS[0] }],
    ["Overdue view", { view: SAVED_VIEWS[1], sort: "deadline" }],
    ["This building view", { view: SAVED_VIEWS[2], scope: "building", buildingId: "b1" }],
    ["quick mine + overdue", { quick: { mine: true, overdue: true } }],
    ["distinct building + deadline preset", { columnFilters: { building: { kind: "distinct", keys: ["North"] }, deadline: { kind: "deadline", presets: ["overdue", "next7"] } } as ActiveFilters }],
    ["priority + contains + number", { columnFilters: { priority: { kind: "distinct", keys: ["High"] }, title: { kind: "contains", query: "up" }, num: { kind: "number", min: 2, max: 6 } } as ActiveFilters }],
  ];
  for (const [name, patch] of cases) {
    it(name, () => {
      const q = { ...base, ...patch };
      const got = selectTaskList(T, q);
      const ref = webReference(q);
      expect(got.rows.map((r) => r.id)).toEqual(ref.ids);
      expect(got.counts).toEqual(ref.counts);
    });
  }

  it("enrichment reuses row objects between runs", () => {
    const a = selectTaskList(T, base).rows;
    const b = selectTaskList(T, { ...base, search: "" }).rows;
    expect(a.every((r, i) => r === b[i])).toBe(true);
    expect(enrichTaskRow(T[0], names)).toBe(enrichTaskRow(T[0], names));
  });

  it("minuteOf is minute granular", () => {
    expect(minuteOf(60_000)).toBe(minuteOf(119_999));
  });
});
