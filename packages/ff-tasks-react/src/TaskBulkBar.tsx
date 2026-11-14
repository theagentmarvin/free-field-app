import { useState, type CSSProperties } from "react";

import { TASK_PRIORITIES, PRIORITY_LABELS, type TaskPriority, type TaskVerb } from "@ff/tasks";

import { bulkStatusVerbs, type BulkOp, type BulkRowInput } from "./bulkLogic";
import { tokens } from "./formStyles";
import { TYPE_OPTIONS } from "./logic";
import { parseDateInput } from "@ff/tasks";

/**
 * Sticky selection bar for multi-select bulk actions. Pure view: it
 * only offers what at least one selected row can take (status verbs are
 * filtered through the state machine) and hands a BulkOp to the host,
 * which plans (planBulk), enqueues and offers Undo.
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

const barStyle: CSSProperties = {
  position: "absolute",
  left: 12,
  right: 12,
  margin: "0 auto",
  width: "fit-content",
  bottom: 44,
  zIndex: 20,
  display: "flex",
  alignItems: "center",
  gap: s.s2,
  flexWrap: "wrap",
  justifyContent: "center",
  maxWidth: "calc(100% - 24px)",
  boxSizing: "border-box",
  padding: `${s.s2}px ${s.s3}px`,
  background: c.primary,
  color: c.onPrimary,
  borderRadius: r.lg,
  boxShadow: tokens.shadow.raised,
  fontFamily: tokens.font,
  fontSize: f.md,
};

const selectStyle: CSSProperties = {
  height: 32,
  borderRadius: r.sm,
  border: "1px solid rgba(255,255,255,0.28)",
  background: "rgba(255,255,255,0.10)",
  color: c.onPrimary,
  fontFamily: "inherit",
  fontSize: f.md,
  padding: "0 8px",
  cursor: "pointer",
  maxWidth: 160,
};

const optStyle: CSSProperties = { color: "#1b1f24", background: "#fff" };

const STATUS_VERB_LABELS: Partial<Record<TaskVerb, string>> = {
  complete: "Complete (submit for approval)",
  reject: "Return to work",
  approve: "Approve",
  followup: "Approve · follow-up",
};

const STATUS_VERBS: readonly TaskVerb[] = ["complete", "reject", "approve", "followup"];

export interface TaskBulkBarProps {
  rows: readonly BulkRowInput[];
  people: readonly { uid: string; name: string }[];
  extendedFields: boolean;
  onApply: (op: BulkOp) => void;
  onDiscontinue: () => void;
  onClear: () => void;
}

export function TaskBulkBar({ rows, people, extendedFields, onApply, onDiscontinue, onClear }: TaskBulkBarProps): JSX.Element {
  const [dateKey, setDateKey] = useState(0);
  const verbs = bulkStatusVerbs(rows, STATUS_VERBS);
  const canDiscontinue = bulkStatusVerbs(rows, ["discontinue"]).length > 0;
  return (
    <div role="toolbar" aria-label={`${rows.length} tasks selected`} className="ff-task-bulk-bar" data-testid="bulk-bar" style={barStyle}>
      <strong data-testid="bulk-count" style={{ padding: "0 6px" }}>
        {rows.length} selected
      </strong>
      <select
        aria-label="Change status"
        data-testid="bulk-status"
        value=""
        disabled={verbs.length === 0}
        onChange={(e) => e.target.value && onApply({ kind: "status", verb: e.target.value as TaskVerb })}
        style={selectStyle}
      >
        <option value="" style={optStyle}>Status…</option>
        {verbs.map((v) => (
          <option key={v} value={v} style={optStyle}>{STATUS_VERB_LABELS[v] ?? v}</option>
        ))}
      </select>
      <select
        aria-label="Change assignee"
        data-testid="bulk-assignee"
        value=""
        onChange={(e) => {
          const v = e.target.value;
          if (!v) return;
          if (v === "__none") onApply({ kind: "assignee", uid: null, name: null });
          else {
            const p = people.find((x) => x.uid === v);
            if (p) onApply({ kind: "assignee", uid: p.uid, name: p.name });
          }
        }}
        style={selectStyle}
      >
        <option value="" style={optStyle}>Assignee…</option>
        <option value="__none" style={optStyle}>Unassign</option>
        {people.map((p) => (
          <option key={p.uid} value={p.uid} style={optStyle}>{p.name}</option>
        ))}
      </select>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: f.sm }}>
        <span>Deadline</span>
        <input
          key={dateKey}
          type="date"
          aria-label="Set deadline"
          data-testid="bulk-deadline"
          onChange={(e) => {
            const ts = parseDateInput(e.target.value);
            if (ts !== null) {
              onApply({ kind: "deadline", deadline: ts });
              setDateKey((k) => k + 1);
            }
          }}
          style={{ ...selectStyle, colorScheme: "dark" }}
        />
        <button
          type="button"
          aria-label="Clear deadline"
          title="Remove deadline"
          data-testid="bulk-deadline-clear"
          onClick={() => onApply({ kind: "deadline", deadline: null })}
          style={{ ...selectStyle, padding: "0 8px" }}
        >
          ×
        </button>
      </label>
      <select
        aria-label="Change type"
        data-testid="bulk-type"
        value=""
        onChange={(e) => e.target.value && onApply({ kind: "type", type: e.target.value })}
        style={selectStyle}
      >
        <option value="" style={optStyle}>Type…</option>
        {TYPE_OPTIONS.map((t) => (
          <option key={t} value={t} style={optStyle}>{t}</option>
        ))}
      </select>
      {extendedFields && (
        <select
          aria-label="Change priority"
          data-testid="bulk-priority"
          value=""
          onChange={(e) => e.target.value && onApply({ kind: "priority", priority: e.target.value as TaskPriority })}
          style={selectStyle}
        >
          <option value="" style={optStyle}>Priority…</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p} style={optStyle}>{PRIORITY_LABELS[p]}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        data-testid="bulk-discontinue"
        disabled={!canDiscontinue}
        onClick={onDiscontinue}
        style={{ ...selectStyle, background: "rgba(214,69,69,0.85)", borderColor: "rgba(214,69,69,1)", fontWeight: 700, opacity: canDiscontinue ? 1 : 0.5 }}
      >
        Discontinue
      </button>
      <button
        type="button"
        data-testid="bulk-clear"
        aria-label="Clear selection"
        onClick={onClear}
        style={{ ...selectStyle, borderColor: "transparent", background: "transparent", fontSize: f.base }}
      >
        ✕
      </button>
    </div>
  );
}
