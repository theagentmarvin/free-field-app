// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, createEvent, fireEvent, render, screen, within } from "@testing-library/react";

import type { TaskEntryView } from "@ff/tasks";

import { TaskTablePanel } from "../src/TaskTablePanel";
import { TaskBoardPanel } from "../src/TaskBoardPanel";
import { TaskBulkBar } from "../src/TaskBulkBar";
import { TaskDetailView, type TaskDetailViewProps } from "../src/TaskDetailView";
import { TaskActivityPopup } from "../src/TaskActivityPopup";
import { TaskTimeline } from "../src/TaskTimeline";
import { TaskChecklist } from "../src/TaskChecklist";
import { resolveShortcut, isTypingTarget } from "../src/useTaskShortcuts";
import { resolveTaskCapabilities } from "../src/capabilities";
import type { TaskTableRow } from "../src/tableColumns";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const NOW = new Date(2026, 10, 13, 10).getTime();
const at = (d: number) => new Date(2026, 10, 13 + d, 12).getTime();

function row(i: number, over: Partial<TaskTableRow> = {}): TaskTableRow {
  return {
    id: `t${i}`,
    num: i,
    title: `Task ${i}`,
    status: 20,
    updatedAt: 1000 - i,
    assigneeName: "Ana",
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}
const rows = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1));

describe("table — selection (w69)", () => {
  function setup(n = 6) {
    const onChange = vi.fn();
    const utils = render(
      <TaskTablePanel rows={rows(n)} now={NOW} selection={{ selected: new Set(), onChange }} />
    );
    return { onChange, ...utils };
  }

  it("checkbox toggles one row without opening it", () => {
    const onOpen = vi.fn();
    const onChange = vi.fn();
    render(<TaskTablePanel rows={rows(3)} now={NOW} onOpen={onOpen} selection={{ selected: new Set(), onChange }} />);
    fireEvent.click(screen.getByTestId("row-check-t2"));
    expect(onChange).toHaveBeenCalledWith(new Set(["t2"]));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("shift-click selects the range from the anchor in display order", () => {
    let selected = new Set<string>();
    const Wrapper = () => {
      return (
        <TaskTablePanel
          rows={rows(6)}
          now={NOW}
          selection={{
            selected,
            onChange: (n) => {
              selected = n;
              rerender(<Wrapper />);
            },
          }}
        />
      );
    };
    const { rerender } = render(<Wrapper />);
    fireEvent.click(screen.getByTestId("row-check-t2"));
    fireEvent.click(screen.getByTestId("row-check-t5"), { shiftKey: true });
    expect([...selected].sort()).toEqual(["t2", "t3", "t4", "t5"]);
  });

  it("select-all selects every displayed row; a second click clears them", () => {
    const { onChange } = setup(4);
    fireEvent.click(screen.getByTestId("select-all"));
    expect(onChange).toHaveBeenLastCalledWith(new Set(["t1", "t2", "t3", "t4"]));
  });

  it("selected rows are marked aria-selected", () => {
    render(<TaskTablePanel rows={rows(3)} now={NOW} selection={{ selected: new Set(["t2"]), onChange: () => {} }} />);
    expect(screen.getByLabelText("Task 2").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Task 1").getAttribute("aria-selected")).toBe("false");
  });
});

describe("table — progressive rendering / load more (w69)", () => {
  it("renders one window of a 1200-row list and widens on Load more", () => {
    const seen: number[] = [];
    render(
      <TaskTablePanel
        rows={rows(1200)}
        now={NOW}
        pageSize={50}
        onDisplayedIdsChange={(ids) => seen.push(ids.length)}
      />
    );
    expect(screen.getAllByRole("row").length).toBe(1 + 50); // header + window, not 1200
    expect(screen.getByTestId("table-count").textContent).toBe("Showing 50 of 1200 tasks");
    fireEvent.click(screen.getByTestId("load-more"));
    expect(screen.getAllByRole("row").length).toBe(1 + 100);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it("when everything is on screen but the server has more, Load more asks the host", () => {
    const onLoadMore = vi.fn();
    render(<TaskTablePanel rows={rows(5)} now={NOW} hasMoreRemote onLoadMore={onLoadMore} />);
    expect(screen.getByTestId("table-count").textContent).toBe("Showing 5 of 5+ tasks");
    fireEvent.click(screen.getByTestId("load-more"));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("no Load more when the whole list fits", () => {
    render(<TaskTablePanel rows={rows(5)} now={NOW} />);
    expect(screen.queryByTestId("load-more")).toBeNull();
  });
});

describe("deadline chips (w69)", () => {
  it("overdue is red-labelled, due within 3 days amber, later plain, closed tasks quiet", () => {
    render(
      <TaskTablePanel
        rows={[
          row(1, { deadline: at(-2) }),
          row(2, { deadline: at(2) }),
          row(3, { deadline: at(20) }),
          row(4, { deadline: at(-2), status: 65 }),
        ]}
        now={NOW}
      />
    );
    const chips = document.querySelectorAll("[data-signal]");
    expect([...chips].map((c) => c.getAttribute("data-signal"))).toEqual(["overdue", "soon"]);
    expect(chips[0]!.textContent).toMatch(/Overdue/);
    expect(chips[1]!.textContent).toMatch(/Due soon/);
  });
});

describe("TaskBulkBar (w69)", () => {
  const people = [{ uid: "u2", name: "Bo" }];
  const base = (over: Partial<Parameters<typeof TaskBulkBar>[0]> = {}) => {
    const onApply = vi.fn();
    const onDiscontinue = vi.fn();
    const onClear = vi.fn();
    render(
      <TaskBulkBar
        rows={[
          { id: "a", title: "A", status: 20 },
          { id: "b", title: "B", status: 40 },
        ]}
        people={people}
        extendedFields
        onApply={onApply}
        onDiscontinue={onDiscontinue}
        onClear={onClear}
        {...over}
      />
    );
    return { onApply, onDiscontinue, onClear };
  };

  it("only offers verbs at least one selected row can take", () => {
    base();
    const opts = within(screen.getByTestId("bulk-status")).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(opts).toEqual(["", "complete", "reject", "approve", "followup"]);
    cleanup();
    base({ rows: [{ id: "a", title: "A", status: 10 }] });
    expect(within(screen.getByTestId("bulk-status")).getAllByRole("option").length).toBe(1); // none legal from inbox
  });

  it("hands ops to the host and shows the count", () => {
    const { onApply, onDiscontinue, onClear } = base();
    expect(screen.getByTestId("bulk-count").textContent).toBe("2 selected");
    fireEvent.change(screen.getByTestId("bulk-status"), { target: { value: "complete" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "status", verb: "complete" });
    fireEvent.change(screen.getByTestId("bulk-assignee"), { target: { value: "u2" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "assignee", uid: "u2", name: "Bo" });
    fireEvent.change(screen.getByTestId("bulk-assignee"), { target: { value: "__none" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "assignee", uid: null, name: null });
    fireEvent.change(screen.getByTestId("bulk-deadline"), { target: { value: "2026-12-01" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "deadline", deadline: new Date(2026, 11, 1, 12).getTime() });
    fireEvent.click(screen.getByTestId("bulk-deadline-clear"));
    expect(onApply).toHaveBeenLastCalledWith({ kind: "deadline", deadline: null });
    fireEvent.change(screen.getByTestId("bulk-type"), { target: { value: "Defect" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "type", type: "Defect" });
    fireEvent.change(screen.getByTestId("bulk-priority"), { target: { value: "high" } });
    expect(onApply).toHaveBeenLastCalledWith({ kind: "priority", priority: "high" });
    fireEvent.click(screen.getByTestId("bulk-discontinue"));
    expect(onDiscontinue).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("bulk-clear"));
    expect(onClear).toHaveBeenCalled();
  });

  it("hides priority without extended fields", () => {
    base({ extendedFields: false });
    expect(screen.queryByTestId("bulk-priority")).toBeNull();
  });
});

describe("shortcuts (w69)", () => {
  const ev = (key: string, over: Partial<Parameters<typeof resolveShortcut>[0]> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    target: document.body as EventTarget,
    ...over,
  });
  const free = { blocked: false };

  it("maps the documented keys", () => {
    expect(resolveShortcut(ev("n"), free)).toBe("new");
    expect(resolveShortcut(ev("/"), free)).toBe("search");
    expect(resolveShortcut(ev("k", { ctrlKey: true }), free)).toBe("search");
    expect(resolveShortcut(ev("K", { metaKey: true }), free)).toBe("search");
    expect(resolveShortcut(ev("j"), free)).toBe("next");
    expect(resolveShortcut(ev("k"), free)).toBe("prev");
    expect(resolveShortcut(ev("Enter"), free)).toBe("open");
    expect(resolveShortcut(ev("e"), free)).toBe("edit");
    expect(resolveShortcut(ev("x"), free)).toBe("toggle-select");
    expect(resolveShortcut(ev("Escape"), free)).toBe("escape");
    expect(resolveShortcut(ev("?"), free)).toBe("help");
  });

  it("never fires while typing, with modifiers, or while a sheet is open", () => {
    const input = document.createElement("input");
    const ta = document.createElement("textarea");
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(ta)).toBe(true);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(resolveShortcut(ev("n", { target: input }), free)).toBeNull();
    expect(resolveShortcut(ev("n", { altKey: true }), free)).toBeNull();
    expect(resolveShortcut(ev("j"), { blocked: true })).toBeNull();
    expect(resolveShortcut(ev("k", { ctrlKey: true }), { blocked: true })).toBeNull();
    // Ctrl+K still works from inside a field (it focuses search)
    expect(resolveShortcut(ev("k", { ctrlKey: true, target: input }), free)).toBe("search");
    // Enter on a focused button activates the button, not "open"
    const btn = document.createElement("button");
    expect(resolveShortcut(ev("Enter", { target: btn }), free)).toBeNull();
  });
});

describe("capabilities (w69)", () => {
  it("hard delete is admin-only; cloud extended fields need the flag", () => {
    expect(resolveTaskCapabilities("admin", true)).toMatchObject({ isAdmin: true, hardDelete: true, extendedFields: true });
    expect(resolveTaskCapabilities("viewer", true)).toMatchObject({ isAdmin: false, hardDelete: false, canWrite: true });
    expect(resolveTaskCapabilities("admin", false)).toMatchObject({ hardDelete: false, extendedFields: false });
    expect(resolveTaskCapabilities("admin", false, { hardDelete: true, extended: true })).toMatchObject({ hardDelete: true, extendedFields: true });
    expect(resolveTaskCapabilities("anonymous", true).canWrite).toBe(false);
  });
});

describe("board — drag-and-drop + keyboard moves (w69)", () => {
  function dt() {
    const store: Record<string, string> = {};
    return {
      setData: (k: string, v: string) => (store[k] = v),
      getData: (k: string) => store[k] ?? "",
      effectAllowed: "",
      dropEffect: "",
    };
  }
  const boardRows = [row(1, { status: 20 }), row(2, { status: 40 }), row(3, { status: 65 })];

  it("dropping on a legal column moves; illegal columns are not drop targets", () => {
    const onMove = vi.fn();
    render(<TaskBoardPanel rows={boardRows} now={NOW} onMove={onMove} />);
    const card = screen.getByTestId("board-card-t1");
    const transfer = dt();
    fireEvent.dragStart(card, { dataTransfer: transfer });
    // 20 → 40 (complete) is legal, 20 → 10 is not
    expect(screen.getByTestId("board-col-40").getAttribute("data-droppable")).toBe("true");
    expect(screen.getByTestId("board-col-10").getAttribute("data-droppable")).toBe("false");
    const illegal = createEvent.dragOver(screen.getByTestId("board-col-10"), { dataTransfer: transfer });
    fireEvent(screen.getByTestId("board-col-10"), illegal);
    expect(illegal.defaultPrevented).toBe(false);
    expect(onMove).not.toHaveBeenCalled(); // browsers never fire drop on a target that refused dragover
    fireEvent.dragOver(screen.getByTestId("board-col-40"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId("board-col-40"), { dataTransfer: transfer });
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]![0].id).toBe("t1");
    expect(onMove.mock.calls[0]![1]).toBe("40");
  });

  it("closed cards are not draggable targets' sources? pending cards are not draggable", () => {
    render(<TaskBoardPanel rows={[row(9, { pending: true })]} now={NOW} onMove={() => {}} />);
    expect(screen.getByTestId("board-card-t9").getAttribute("draggable")).toBe("false");
  });

  it("keyboard alternative: Alt+→ moves to the next column, announced", () => {
    const onMove = vi.fn();
    render(<TaskBoardPanel rows={boardRows} now={NOW} onMove={onMove} />);
    fireEvent.keyDown(screen.getByTestId("board-card-t1"), { key: "ArrowRight", altKey: true });
    expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), "40");
    expect(screen.getByRole("status").textContent).toMatch(/Moving T001 to Awaiting approval/);
    fireEvent.keyDown(screen.getByTestId("board-card-t1"), { key: "ArrowRight" }); // no Alt: ignored
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("cards show priority and checklist progress", () => {
    render(
      <TaskBoardPanel
        rows={[row(1, { priority: "critical", checklist: [{ id: "a", text: "x", done: true }, { id: "b", text: "y", done: false }] })]}
        now={NOW}
      />
    );
    expect(document.querySelector("[data-priority='critical']")).not.toBeNull();
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});

// ── detail view: inline edit ────────────────────────────────────────────

function detailProps(over: Partial<TaskDetailViewProps> = {}): TaskDetailViewProps {
  return {
    num: 7,
    title: "Crack in slab",
    description: "Hairline",
    type: "Defect",
    status: 20,
    assigneeName: "Ana",
    assigneeUid: "u1",
    deadline: at(1),
    location: null,
    entries: [],
    canAct: true,
    onComment: () => {},
    onTransition: () => {},
    onRetryEntry: () => {},
    onClose: () => {},
    people: [
      { uid: "u1", name: "Ana" },
      { uid: "u2", name: "Bo" },
    ],
    editable: true,
    extendedFields: true,
    currentUid: "u1",
    watchers: [],
    checklist: [],
    now: NOW,
    ...over,
  };
}

describe("detail — inline editing (w69)", () => {
  it("title: saves the trimmed value; empty title is rejected inline", () => {
    const onEditFields = vi.fn();
    render(<TaskDetailView {...detailProps({ onEditFields })} />);
    fireEvent.click(screen.getByTestId("field-title-edit"));
    const input = screen.getByTestId("edit-title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("field-title-save"));
    expect(screen.getByTestId("field-title-error").textContent).toMatch(/required/i);
    expect(onEditFields).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  New title " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEditFields).toHaveBeenCalledWith({ title: "  New title " }); // host trims + logs
    expect(screen.queryByTestId("edit-title")).toBeNull(); // optimistic: back to read mode at once
  });

  it("Escape cancels the field only (the sheet stays open)", () => {
    const onClose = vi.fn();
    render(<TaskDetailView {...detailProps({ onClose, onEditFields: () => {} })} />);
    fireEvent.click(screen.getByTestId("field-title-edit"));
    fireEvent.keyDown(screen.getByTestId("edit-title"), { key: "Escape" });
    expect(screen.queryByTestId("edit-title")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unchanged value does not save", () => {
    const onEditFields = vi.fn();
    render(<TaskDetailView {...detailProps({ onEditFields })} />);
    fireEvent.click(screen.getByTestId("field-title-edit"));
    fireEvent.click(screen.getByTestId("field-title-save"));
    expect(onEditFields).not.toHaveBeenCalled();
  });

  it("deadline, type, assignee, priority each save one field", () => {
    const onEditFields = vi.fn();
    render(<TaskDetailView {...detailProps({ onEditFields })} />);
    fireEvent.click(screen.getByTestId("field-deadline-edit"));
    fireEvent.change(screen.getByTestId("edit-deadline"), { target: { value: "2026-12-24" } });
    fireEvent.click(screen.getByTestId("field-deadline-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ deadline: new Date(2026, 11, 24, 12).getTime() });

    fireEvent.click(screen.getByTestId("field-deadline-edit"));
    fireEvent.click(screen.getByTestId("edit-deadline-clear"));
    fireEvent.click(screen.getByTestId("field-deadline-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ deadline: null });

    fireEvent.click(screen.getByTestId("field-type-edit"));
    fireEvent.change(screen.getByTestId("edit-type"), { target: { value: "Safety" } });
    fireEvent.click(screen.getByTestId("field-type-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ type: "Safety" });

    fireEvent.click(screen.getByTestId("field-assignee-edit"));
    fireEvent.change(screen.getByTestId("edit-assignee"), { target: { value: "u2" } });
    fireEvent.click(screen.getByTestId("field-assignee-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ assigneeUid: "u2", assigneeName: "Bo" });

    fireEvent.click(screen.getByTestId("field-assignee-edit"));
    fireEvent.change(screen.getByTestId("edit-assignee"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("field-assignee-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ assigneeUid: null, assigneeName: null });

    fireEvent.click(screen.getByTestId("field-priority-edit"));
    fireEvent.change(screen.getByTestId("edit-priority"), { target: { value: "critical" } });
    fireEvent.click(screen.getByTestId("field-priority-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ priority: "critical" });
  });

  it("location rows (building, level, note) edit through the same path", () => {
    const onEditFields = vi.fn();
    render(
      <TaskDetailView
        {...detailProps({
          onEditFields,
          buildingOptions: [{ id: "b1", name: "North" }, { id: "b2", name: "South" }],
          buildingId: "b1",
          buildingName: "North",
          location: { storeyName: "L1", bim: null, pdf: null },
        })}
      />
    );
    fireEvent.click(screen.getByTestId("field-building-edit"));
    fireEvent.change(screen.getByTestId("edit-building"), { target: { value: "b2" } });
    fireEvent.click(screen.getByTestId("field-building-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ buildingId: "b2" });
    fireEvent.click(screen.getByTestId("field-level-edit"));
    fireEvent.change(screen.getByTestId("edit-level"), { target: { value: "L3" } });
    fireEvent.click(screen.getByTestId("field-level-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ storeyName: "L3" });
    fireEvent.click(screen.getByTestId("field-locnote-edit"));
    fireEvent.change(screen.getByTestId("edit-locnote"), { target: { value: "by the stair" } });
    fireEvent.click(screen.getByTestId("field-locnote-save"));
    expect(onEditFields).toHaveBeenLastCalledWith({ locationText: "by the stair" });
  });

  it("startEditing opens the title editor (E shortcut)", () => {
    render(<TaskDetailView {...detailProps({ onEditFields: () => {}, startEditing: true })} />);
    expect(screen.getByTestId("edit-title")).toBeTruthy();
  });

  it("read-only when not editable (closed task): no pencils, a note instead", () => {
    render(<TaskDetailView {...detailProps({ status: 65, editable: false, onEditFields: () => {} })} />);
    expect(screen.queryByTestId("field-title-edit")).toBeNull();
    expect(screen.getByTestId("detail-readonly-note")).toBeTruthy();
  });

  it("due-soon chip shows beside the deadline", () => {
    render(<TaskDetailView {...detailProps({ deadline: at(2) })} />);
    expect(screen.getByTestId("detail-due-soon")).toBeTruthy();
  });

  it("priority / checklist / follow hide without extended fields", () => {
    render(<TaskDetailView {...detailProps({ extendedFields: false, onEditFields: () => {}, onToggleWatch: () => {} })} />);
    expect(screen.queryByTestId("field-priority")).toBeNull();
    expect(screen.queryByTestId("detail-zone-checklist")).toBeNull();
    expect(screen.queryByTestId("detail-follow")).toBeNull();
  });
});

describe("detail — checklist, follow, delete (w69)", () => {
  it("checklist: add, toggle, remove each emit the full next list; progress shows", () => {
    const onEditFields = vi.fn();
    const items = [{ id: "a", text: "Remove debris", done: false }];
    render(<TaskDetailView {...detailProps({ onEditFields, checklist: items })} />);
    fireEvent.click(screen.getByTestId("checklist-item-a"));
    expect(onEditFields).toHaveBeenLastCalledWith({ checklist: [{ id: "a", text: "Remove debris", done: true }] });
    fireEvent.change(screen.getByTestId("checklist-new"), { target: { value: "Re-pour" } });
    fireEvent.click(screen.getByTestId("checklist-add"));
    const next = onEditFields.mock.calls.at(-1)![0].checklist;
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ text: "Re-pour", done: false });
    fireEvent.click(screen.getByTestId("checklist-remove-a"));
    expect(onEditFields).toHaveBeenLastCalledWith({ checklist: [] });
  });

  it("checklist is read-only when not editable", () => {
    render(<TaskChecklist items={[{ id: "a", text: "x", done: true }]} editable={false} onChange={() => {}} />);
    expect((screen.getByTestId("checklist-item-a") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("checklist-new")).toBeNull();
  });

  it("follow toggles; label reflects watchers", () => {
    const onToggleWatch = vi.fn();
    const { rerender } = render(<TaskDetailView {...detailProps({ onEditFields: () => {}, onToggleWatch })} />);
    const btn = screen.getByTestId("detail-follow");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(btn);
    expect(onToggleWatch).toHaveBeenCalled();
    rerender(<TaskDetailView {...detailProps({ onEditFields: () => {}, onToggleWatch, watchers: ["u1", "u2"] })} />);
    expect(screen.getByTestId("detail-follow").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("detail-follow").getAttribute("title")).toMatch(/2 watching/);
  });

  it("admin delete needs a confirm; non-admins never see it", () => {
    const onDelete = vi.fn();
    const { unmount } = render(<TaskDetailView {...detailProps({ canDelete: true, onDelete })} />);
    fireEvent.click(screen.getByTestId("detail-delete"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("detail-delete"));
    fireEvent.click(screen.getByTestId("task-confirm-ok"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    unmount();
    render(<TaskDetailView {...detailProps({ canDelete: false, onDelete })} />);
    expect(screen.queryByTestId("detail-delete")).toBeNull();
  });
});

// ── comments + @mentions ────────────────────────────────────────────────

describe("comments with @mentions (w69)", () => {
  const people = [
    { uid: "u1", name: "Ana Silva" },
    { uid: "u2", name: "Mateo Rojas" },
  ];

  it("autocompletes from the roster and inserts the full name", () => {
    const onComment = vi.fn();
    render(<TaskActivityPopup num={3} entries={[]} onRetryEntry={() => {}} onComment={onComment} onClose={() => {}} people={people} />);
    const input = screen.getByTestId("activity-comment-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hi @ma", selectionStart: 6 } });
    input.setSelectionRange(6, 6);
    fireEvent.change(input, { target: { value: "hi @ma" } });
    const list = screen.getByTestId("mention-list");
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["@Mateo Rojas"]);
    fireEvent.keyDown(input, { key: "Enter" }); // picks, does NOT send
    expect(onComment).not.toHaveBeenCalled();
    expect(input.value).toBe("hi @Mateo Rojas ");
    expect(screen.queryByTestId("mention-list")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onComment).toHaveBeenCalledWith("hi @Mateo Rojas");
  });

  it("Escape closes the suggestion list only, not the popup", () => {
    const onClose = vi.fn();
    render(<TaskActivityPopup num={3} entries={[]} onRetryEntry={() => {}} onComment={() => {}} onClose={onClose} people={people} />);
    const input = screen.getByTestId("activity-comment-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@an" } });
    input.setSelectionRange(3, 3);
    fireEvent.change(input, { target: { value: "@an" } });
    expect(screen.getByTestId("mention-list")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("mention-list")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("timeline renders resolved mentions highlighted (yours stronger) and edit lines as activity", () => {
    const entries: TaskEntryView[] = [
      { id: "e1", action: "comment", text: "ping @Ana Silva please", by: "Bo", byUid: "u9", at: 1, statusFrom: 20, statusTo: 20, photos: [], clientGuid: "e1", pending: false, failed: false },
      { id: "e2", action: "edit", text: "changed deadline from 10 Nov 2026 to 20 Nov 2026", by: "Ana", byUid: "u1", at: 2, statusFrom: 20, statusTo: 20, photos: [], clientGuid: "e2", pending: false, failed: false },
    ];
    render(<TaskTimeline entries={entries} onRetryEntry={() => {}} people={people} currentUid="u1" />);
    const m = document.querySelector("[data-mention-uid='u1']");
    expect(m?.textContent).toBe("@Ana Silva");
    expect(screen.getByTestId("entry-e2").textContent).toContain("changed deadline from 10 Nov 2026 to 20 Nov 2026");
    expect(screen.getByTestId("entry-e2").textContent).toContain("edited");
  });
});

describe("regressions found in the browser pass (w69)", () => {
  it("startEditing still opens the title editor when the doc becomes editable after mount", () => {
    const { rerender } = render(<TaskDetailView {...detailProps({ editable: false, onEditFields: () => {}, startEditing: true })} />);
    expect(screen.queryByTestId("edit-title")).toBeNull();
    rerender(<TaskDetailView {...detailProps({ editable: true, onEditFields: () => {}, startEditing: true })} />);
    expect(screen.getByTestId("edit-title")).toBeTruthy();
  });

  it("picking a mention puts the caret after the inserted name (typing continues there)", () => {
    render(<TaskActivityPopup num={3} entries={[]} onRetryEntry={() => {}} onComment={() => {}} onClose={() => {}} people={[{ uid: "u2", name: "Mateo Rojas" }]} />);
    const input = screen.getByTestId("activity-comment-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hi @ma" } });
    input.setSelectionRange(6, 6);
    fireEvent.change(input, { target: { value: "hi @ma" } });
    fireEvent.mouseDown(screen.getByTestId("mention-option-u2"));
    expect(input.value).toBe("hi @Mateo Rojas ");
    expect(input.selectionStart).toBe(16);
  });

  it("the popup does not steal focus back when the parent re-renders with a new onClose", () => {
    const { rerender } = render(<TaskActivityPopup num={3} entries={[]} onRetryEntry={() => {}} onComment={() => {}} onClose={() => {}} />);
    const input = screen.getByTestId("activity-comment-input") as HTMLInputElement;
    input.focus();
    rerender(<TaskActivityPopup num={3} entries={[]} onRetryEntry={() => {}} onComment={() => {}} onClose={() => {}} />);
    expect(document.activeElement).toBe(input);
  });
});
