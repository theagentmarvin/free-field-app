import { useRef, useEffect, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";

import type { TaskView } from "@ff/tasks";

import {
  formatTaskNum,
  groupTasks,
  initialsOf,
  STATUS_LABELS,
  type GroupKey,
} from "./logic";
import {
  avatarAccent,
  avatarMiniStyle,
  chipStyle,
  softStatusDotStyle,
  statusAccent,
  tokens,
} from "./formStyles";
import type { TaskTableRow } from "./tableColumns";
import { adjacentColumn, planBoardMove } from "./boardMove";
import { ChecklistProgress, DeadlineChip, PriorityChip } from "./TaskChips";
import { normalizeChecklist, priorityOf } from "@ff/tasks";

/**
 * Tasks UI refresh v1 (§4 · NEW) — the Board view.
 *
 * Columns map 1:1 onto the existing `Chip`/status set:
 * Inbox (10) · Ongoing (20) · Awaiting approval (40) · Follow-up (60) ·
 * Terminal (30/65/80, the quiet archive column). Cards are compressed
 * table rows: mono T# + title + soft status dot + avatar + relative
 * deadline + photo count. Tapping a card fires the SAME `onOpen` path a
 * table row uses (spec §6.4) — NO drag-and-drop in v1 (Q2: tap-only).
 *
 * Group-aware: when the module groups by Building/Assignee the group
 * label rides on each card's meta row (the columns stay status-based).
 * Desktop-only — phones keep the <TasksListPanel> card branch behind
 * <TasksApp>'s useIsWide gate (spec §5).
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export interface BoardColumn {
  key: string;
  label: string;
  statuses: readonly number[];
}

/** The frozen status→column map (spec §4: 10/20/40/60/terminal). */
export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { key: "10", label: "Inbox", statuses: [10] },
  { key: "20", label: "Ongoing", statuses: [20] },
  { key: "40", label: "Awaiting approval", statuses: [40] },
  { key: "60", label: "Follow-up", statuses: [60] },
  { key: "terminal", label: "Closed", statuses: [30, 65, 80] },
];

export function boardColumnFor(status: number): BoardColumn {
  return BOARD_COLUMNS.find((col) => col.statuses.includes(status)) ?? BOARD_COLUMNS[0]!;
}

const boardStyle: CSSProperties = {
  display: "flex",
  gap: s.s3,
  alignItems: "flex-start",
  height: "100%",
  overflowX: "auto",
  overflowY: "hidden",
  padding: s.s3,
  boxSizing: "border-box",
};

const columnStyle: CSSProperties = {
  flex: "1 1 220px",
  minWidth: 220,
  maxWidth: 340,
  display: "flex",
  flexDirection: "column",
  gap: s.s2,
  maxHeight: "100%",
  overflowY: "auto",
};

const columnHeaderStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  display: "flex",
  alignItems: "center",
  gap: s.s2,
  padding: `5px ${s.s2}px`,
  background: c.surface2,
  border: `1px solid ${c.border}`,
  borderRadius: r.md,
  fontSize: f.xs,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: c.muted,
};

const cardBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: r.md,
  boxShadow: tokens.shadow.card,
  padding: `${s.s2 + 2}px ${s.s3}px`,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  color: c.text,
};

export interface TaskBoardPanelProps {
  rows: readonly TaskTableRow[];
  now: number;
  /** SAME open path a table row uses (spec §6.4). */
  onOpen?: (task: TaskView) => void;
  /** active group-by (Status/Building/Assignee) — the label rides on
   *  the card meta; the columns stay status-based. */
  groupBy?: GroupKey;
  emptyLabel?: string;
  /** keyboard-focused card (J/K from the host) */
  activeId?: string | null;
  /** w69 — move a card to a status column (drag-and-drop or Alt+←/→).
   *  The host validates legality again (planBoardMove) before writing. */
  onMove?: (task: TaskView, columnKey: string) => void;
  hasMoreRemote?: boolean;
  onLoadMore?: () => void;
}

export function TaskBoardPanel({
  rows,
  now,
  onOpen,
  groupBy = "none",
  emptyLabel = "No tasks match this filter.",
  activeId = null,
  onMove,
  hasMoreRemote = false,
  onLoadMore,
}: TaskBoardPanelProps): JSX.Element {
  const [pressed, setPressed] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  const dragged = dragId ? rows.find((t) => t.id === dragId) ?? null : null;
  const canDrop = (col: BoardColumn): boolean =>
    !!dragged && !!onMove && planBoardMove(dragged.status, col.key) !== null;

  function onCardKey(e: KeyboardEvent, t: TaskView): void {
    if (!onMove || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const from = boardColumnFor(t.status).key;
    const to = adjacentColumn(from, e.key === "ArrowLeft" ? -1 : 1);
    if (!to) return;
    const plan = planBoardMove(t.status, to);
    setAnnounce(
      plan
        ? `Moving ${formatTaskNum(t.num)} to ${BOARD_COLUMNS.find((c2) => c2.key === to)?.label}`
        : `${formatTaskNum(t.num)} cannot move to ${BOARD_COLUMNS.find((c2) => c2.key === to)?.label} from here`
    );
    onMove(t, to);
  }

  if (rows.length === 0) {
    return (
      <div className="ff-tasks-empty" style={{ padding: s.s5, color: c.muted, fontSize: f.md }}>
        {emptyLabel}
      </div>
    );
  }

  // Group label lookup (only when grouping by something other than
  // status — the column IS the status group then).
  const groups = groupBy !== "none" && groupBy !== "status" ? groupTasks(rows, groupBy) : [];
  const labelByTaskId = new Map<string, string>();
  for (const g of groups) for (const t of g.rows) labelByTaskId.set(t.id, g.label);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
    <div aria-live="polite" role="status" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
      {announce}
    </div>
    <div className="ff-task-board" role="list" aria-label="Task board" style={{ ...boardStyle, flex: "1 1 auto", minHeight: 0, height: "auto" }}>
      {BOARD_COLUMNS.map((col) => {
        const cards = rows.filter((t) => col.statuses.includes(t.status));
        const droppable = canDrop(col);
        const hot = overCol === col.key && droppable;
        return (
          <section
            key={col.key}
            className="ff-task-board-column"
            data-testid={`board-col-${col.key}`}
            data-droppable={dragId ? String(droppable) : undefined}
            style={{
              ...columnStyle,
              borderRadius: r.md,
              outline: hot ? `2px solid ${c.focusRing}` : dragId && droppable ? `2px dashed ${c.focusRingLine}` : undefined,
              outlineOffset: 2,
              opacity: dragId && !droppable && boardColumnFor(dragged?.status ?? 0).key !== col.key ? 0.55 : 1,
            }}
            onDragOver={(e: DragEvent) => {
              if (!droppable) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverCol(col.key);
            }}
            onDragLeave={() => setOverCol((cur) => (cur === col.key ? null : cur))}
            onDrop={(e: DragEvent) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain") || dragId;
              const task = rows.find((t) => t.id === id);
              setDragId(null);
              setOverCol(null);
              if (task && droppable) onMove?.(task, col.key);
            }}
          >
            <header style={columnHeaderStyle}>
              <span>{col.label}</span>
              <span style={{ marginLeft: "auto", fontWeight: 700 }}>{cards.length}</span>
            </header>
            {cards.length === 0 && (
              <div
                aria-hidden
                style={{
                  border: `1px dashed ${c.borderStrong}`,
                  borderRadius: r.md,
                  minHeight: 48,
                  background: c.surface2,
                }}
              />
            )}
            {cards.map((t) => {
              const accent = labelByTaskId.get(t.id) ?? null;
              const name = (t.assigneeName ?? "").trim();
              return (
                <button
                  key={t.id}
                  ref={activeId === t.id ? activeRef : undefined}
                  type="button"
                  className="ff-task-board-card"
                  data-testid={`board-card-${t.id}`}
                  aria-label={`${formatTaskNum(t.num)} ${t.title}`}
                  aria-describedby={onMove ? "ff-board-move-hint" : undefined}
                  draggable={!!onMove && !t.pending}
                  onDragStart={(e: DragEvent) => {
                    e.dataTransfer.setData("text/plain", t.id);
                    e.dataTransfer.effectAllowed = "move";
                    setDragId(t.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverCol(null);
                  }}
                  onKeyDown={(e) => onCardKey(e, t)}
                  style={{
                    ...cardBodyStyle,
                    transform: pressed === t.id ? "translateY(1px)" : undefined,
                    opacity: dragId === t.id ? 0.4 : t.pending && !t.failed ? 0.6 : 1,
                    cursor: onMove && !t.pending ? "grab" : "pointer",
                    outline: activeId === t.id ? `2px solid ${c.focusRing}` : undefined,
                    outlineOffset: 1,
                  }}
                  onMouseDown={() => setPressed(t.id)}
                  onMouseUp={() => setPressed(null)}
                  onMouseLeave={() => setPressed(null)}
                  onClick={() => onOpen?.(t)}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    <span
                      style={{ fontVariantNumeric: "tabular-nums", fontSize: f.sm, color: c.muted }}
                    >
                      {formatTaskNum(t.num)}
                    </span>
                    <span
                      title={STATUS_LABELS[t.status] ?? String(t.status)}
                      style={{ ...softStatusDotStyle, marginLeft: "auto", background: dotColor(t.status) }}
                      aria-hidden
                    />
                  </span>
                  <span
                    style={{
                      fontSize: f.md,
                      fontWeight: 600,
                      color: c.text,
                      overflow: "hidden",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    }}
                  >
                    {t.title}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: f.xs, color: c.muted }}>
                    {name ? (
                      <span
                        aria-hidden
                        style={{ ...avatarMiniStyle, width: 18, height: 18, fontSize: 9, background: avatarAccent(name) }}
                      >
                        {initialsOf(name)}
                      </span>
                    ) : null}
                    {(t.photos?.length ?? 0) > 0 && <span aria-hidden>📷{t.photos!.length}</span>}
                    {(t.deadline ?? 0) > 0 && (
                      <span style={{ marginLeft: "auto" }}>
                        <DeadlineChip deadline={t.deadline ?? null} status={t.status} now={now} compact />
                      </span>
                    )}
                  </span>
                  {(priorityOf(t.priority) !== "normal" || normalizeChecklist(t.checklist).length > 0) && (
                    <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {priorityOf(t.priority) !== "normal" && <PriorityChip priority={t.priority} />}
                      <ChecklistProgress items={normalizeChecklist(t.checklist)} />
                    </span>
                  )}
                  {accent && (
                    <span style={{ ...chipStyle, alignSelf: "flex-start", fontSize: f.xs }}>{accent}</span>
                  )}
                  {t.failed && (
                    <span style={{ fontSize: f.xs, color: c.danger, fontWeight: 700 }}>⚠ queued action failed</span>
                  )}
                </button>
              );
            })}
          </section>
        );
      })}
    </div>
    <span id="ff-board-move-hint" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
      Drag to another column, or press Alt plus Left or Right arrow to move this task.
    </span>
    {hasMoreRemote && onLoadMore && (
      <div role="status" style={{ flex: "0 0 auto", display: "flex", justifyContent: "center", gap: s.s3, alignItems: "center", padding: "6px 12px", borderTop: `1px solid ${c.border}`, background: c.surface2, fontSize: f.sm, color: c.text2 }}>
        <span>Showing {rows.length} loaded tasks</span>
        <button type="button" data-testid="board-load-more" onClick={onLoadMore} style={{ border: `1px solid ${c.borderStrong}`, background: c.surface, color: c.focusRingInk, borderRadius: r.md, padding: "3px 12px", fontWeight: 700, fontSize: f.sm, cursor: "pointer", fontFamily: "inherit" }}>
          Load more
        </button>
      </div>
    )}
    </div>
  );
}

// The dot uses the SAME accent palette as the soft status cells —
// resolved through formStyles tokens (no new hexes).
function dotColor(status: number): string {
  return statusAccent(status).bg;
}
