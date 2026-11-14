import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COLUMN_IDS,
  COLUMN_STORAGE_KEY,
  DEFAULT_VISIBLE_COLUMNS,
  PINNED_COLUMN,
  TABLE_COLUMNS,
  filterColumns,
  loadVisibleColumns,
  saveVisibleColumns,
  sortRowsByColumn,
  toggleColumn,
  type ColumnId,
  type TaskTableRow,
} from "../src/tableColumns";

/**
 * Wave 5A · pure table-column logic (tableColumns.ts). Node env — the
 * only browser surface touched is `localStorage`, stubbed below so the
 * persist round-trip + corrupt→defaults paths are deterministic.
 */

function row(over: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: "t1",
    num: 1,
    title: "A task",
    status: 20,
    updatedAt: 100,
    assigneeName: null,
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

function storageMock(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", storageMock());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registry completeness", () => {
  it("covers every spec-listed field in order (num…location)", () => {
    expect(TABLE_COLUMNS.map((c) => c.id)).toEqual([...COLUMN_IDS]);
    expect(TABLE_COLUMNS.map((c) => c.id)).toEqual([
      "num",
      "title",
      "type",
      "status",
      "priority",
      "assigneeName",
      "building",
      "deadline",
      "checklist",
      "createdBy",
      "createdAt",
      "updatedAt",
      "photos",
      "entryCount",
      "location",
    ]);
  });

  it("every column is sortable (has a sortValue)", () => {
    for (const c of TABLE_COLUMNS) {
      expect(c.sortValue, `column ${c.id} must be sortable`).toBeTypeOf("function");
    }
  });

  it("num is the pinned column and leads the approved defaults", () => {
    expect(PINNED_COLUMN).toBe("num");
    expect(DEFAULT_VISIBLE_COLUMNS[0]).toBe("num");
  });
});

describe("sortRowsByColumn — sortValue correctness", () => {
  it("status sorts numerically", () => {
    const rows = [row({ id: "a", status: 40 }), row({ id: "b", status: 10 }), row({ id: "c", status: 20 })];
    expect(sortRowsByColumn(rows, "status", "asc", 0).map((r) => r.status)).toEqual([10, 20, 40]);
    expect(sortRowsByColumn(rows, "status", "desc", 0).map((r) => r.status)).toEqual([40, 20, 10]);
  });

  it("num sorts numerically", () => {
    const rows = [row({ id: "a", num: 9 }), row({ id: "b", num: 2 }), row({ id: "c", num: 5 })];
    expect(sortRowsByColumn(rows, "num", "asc", 0).map((r) => r.num)).toEqual([2, 5, 9]);
  });

  it("deadline sorts soonest-first; missing deadline always last both ways", () => {
    const rows = [
      row({ id: "a", deadline: 300 }),
      row({ id: "b", deadline: 100 }),
      row({ id: "c", deadline: null }),
    ];
    expect(sortRowsByColumn(rows, "deadline", "asc", 0).map((r) => r.id)).toEqual(["b", "a", "c"]);
    expect(sortRowsByColumn(rows, "deadline", "desc", 0).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("string columns sort case-insensitively", () => {
    const rows = [row({ id: "a", title: "zebra" }), row({ id: "b", title: "Apple" }), row({ id: "c", title: "mango" })];
    expect(sortRowsByColumn(rows, "title", "asc", 0).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("none returns incoming order untouched (new array, same order)", () => {
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    const out = sortRowsByColumn(rows, "status", "none", 0);
    expect(out).not.toBe(rows);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("toggleColumn", () => {
  it("adds and removes freely", () => {
    let s: ReadonlySet<ColumnId> = new Set<ColumnId>(["num", "title"]);
    s = toggleColumn(s, "status", true);
    expect(s.has("status")).toBe(true);
    s = toggleColumn(s, "title", false);
    expect(s.has("title")).toBe(false);
    expect(s.has("num")).toBe(true);
  });

  it("num is pinned — removal is a no-op", () => {
    const s = new Set<ColumnId>(["num", "title"]);
    const out = toggleColumn(s, "num", false);
    expect(out.has("num")).toBe(true);
    expect(out.has("title")).toBe(true);
  });
});

describe("filterColumns", () => {
  it("empty query returns the full registry", () => {
    expect(filterColumns("")).toHaveLength(15);
    expect(filterColumns("   ")).toHaveLength(15);
  });

  it("UI-refresh v1: building is a default-visible column", () => {
    expect(DEFAULT_VISIBLE_COLUMNS).toContain("building");
    expect(filterColumns("BUILD").map((c) => c.id)).toEqual(["building"]);
  });

  it("filters by case-insensitive label substring", () => {
    expect(filterColumns("dead").map((c) => c.id)).toEqual(["deadline"]);
    expect(filterColumns("ASSIGN").map((c) => c.id)).toEqual(["assigneeName"]);
  });
});

describe("persist/filter round-trip (localStorage)", () => {
  it("save then load round-trips", () => {
    const set = new Set<ColumnId>(["num", "title", "photos", "entryCount"]);
    saveVisibleColumns(set);
    expect(localStorage.getItem(COLUMN_STORAGE_KEY)).toBe(
      JSON.stringify(["num", "title", "photos", "entryCount"])
    );
    expect([...loadVisibleColumns()].sort()).toEqual(["entryCount", "num", "photos", "title"]);
  });

  it("unset key → approved defaults", () => {
    expect([...loadVisibleColumns()].sort()).toEqual(
      [...new Set<ColumnId>([...DEFAULT_VISIBLE_COLUMNS, PINNED_COLUMN])].sort()
    );
  });

  it("corrupt JSON → approved defaults", () => {
    localStorage.setItem(COLUMN_STORAGE_KEY, "not-json{");
    expect([...loadVisibleColumns()].sort()).toEqual(
      [...new Set<ColumnId>([...DEFAULT_VISIBLE_COLUMNS, PINNED_COLUMN])].sort()
    );
  });

  it("non-array value → approved defaults", () => {
    localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(42));
    expect([...loadVisibleColumns()].sort()).toEqual(
      [...new Set<ColumnId>([...DEFAULT_VISIBLE_COLUMNS, PINNED_COLUMN])].sort()
    );
  });

  it("unknown ids are dropped and num is pinned back in", () => {
    localStorage.setItem(
      COLUMN_STORAGE_KEY,
      JSON.stringify(["title", "bogus", "photos"])
    );
    const loaded = loadVisibleColumns();
    expect(loaded.has("title")).toBe(true);
    expect(loaded.has("photos")).toBe(true);
    expect(loaded.has("bogus" as ColumnId)).toBe(false);
    expect(loaded.has("num")).toBe(true); // pinned regardless
  });
});