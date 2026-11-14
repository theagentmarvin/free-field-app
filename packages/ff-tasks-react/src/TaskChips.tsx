import type { CSSProperties } from "react";

import { PRIORITY_LABELS, priorityOf, type ChecklistItem, type TaskPriority, checklistProgress } from "@ff/tasks";

import { tokens } from "./formStyles";
import { deadlineSignal, relativeDeadlineLabel } from "./logic";
import { fmtDdMmm } from "./tableColumns";

/**
 * Small presentational chips shared by the table, board, cards and the
 * detail sheet: deadline (overdue red / due-soon amber), priority and
 * checklist progress. Colours are fixed hexes with AA-contrast ink; the
 * label always carries the meaning (never colour alone).
 */

const { radius: r, fontSize: f } = tokens;

const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 20,
  padding: "0 8px",
  borderRadius: r.pill,
  fontSize: f.xs,
  fontWeight: 700,
  whiteSpace: "nowrap",
  lineHeight: 1,
};

const DEADLINE_TONE = {
  overdue: { background: "#fde8e8", color: "#a12020", border: "1px solid #f3bcbc" },
  soon: { background: "#fdf1d8", color: "#7a4b00", border: "1px solid #f0d49a" },
} as const;

export function DeadlineChip({
  deadline,
  status,
  now,
  compact = false,
}: {
  deadline: number | null | undefined;
  status: number;
  now: number;
  compact?: boolean;
}): JSX.Element {
  if (typeof deadline !== "number" || deadline <= 0) return <span style={{ color: tokens.color.muted }}>—</span>;
  const sig = deadlineSignal(deadline, status, now);
  const rel = relativeDeadlineLabel(deadline, now);
  const text = rel ? rel.label : fmtDdMmm(deadline);
  if (!sig) return <span style={{ color: tokens.color.text2 }}>{text}</span>;
  return (
    <span
      className={`ff-task-deadline-chip ff-task-deadline-chip--${sig}`}
      data-signal={sig}
      title={`${fmtDdMmm(deadline)} · ${sig === "overdue" ? "Overdue" : "Due soon"}`}
      style={{ ...base, ...DEADLINE_TONE[sig] }}
    >
      <span aria-hidden>{sig === "overdue" ? "⚠" : "◔"}</span>
      {compact ? text : sig === "overdue" ? `${text} · Overdue` : `${text} · Due soon`}
    </span>
  );
}

const PRIORITY_TONE: Record<TaskPriority, CSSProperties> = {
  low: { background: "#eef1f4", color: "#4b5560", border: "1px solid #dde2e8" },
  normal: { background: "#eef3fd", color: "#2a5bb8", border: "1px solid #cfdcf6" },
  high: { background: "#fdf1d8", color: "#7a4b00", border: "1px solid #f0d49a" },
  critical: { background: "#fde8e8", color: "#a12020", border: "1px solid #f3bcbc" },
};

export function priorityToneStyle(p: TaskPriority): CSSProperties {
  return { ...base, ...PRIORITY_TONE[p] };
}

export function PriorityChip({ priority }: { priority: unknown }): JSX.Element {
  const p = priorityOf(priority);
  return (
    <span className="ff-task-priority-chip" data-priority={p} style={priorityToneStyle(p)}>
      {p === "critical" && <span aria-hidden>!</span>}
      {PRIORITY_LABELS[p]}
    </span>
  );
}

export function ChecklistProgress({ items, wide = false }: { items: readonly ChecklistItem[] | undefined | null; wide?: boolean }): JSX.Element | null {
  const { done, total } = checklistProgress(items);
  if (total === 0) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <span
      className="ff-task-checklist-progress"
      title={`${done} of ${total} checklist items done`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: f.xs, fontWeight: 700, color: done === total ? "#188038" : tokens.color.text2 }}
    >
      <span
        aria-hidden
        style={{ width: wide ? 56 : 36, height: 5, borderRadius: 3, background: tokens.color.border, overflow: "hidden", display: "inline-block" }}
      >
        <span style={{ display: "block", width: `${pct}%`, height: "100%", background: done === total ? "#22a558" : tokens.color.focusRing }} />
      </span>
      {done}/{total}
    </span>
  );
}
