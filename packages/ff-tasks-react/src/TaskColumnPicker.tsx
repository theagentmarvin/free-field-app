import { useState, type CSSProperties } from "react";

import { AnchoredPopover } from "./AnchoredPopover";

import {
  filterColumns,
  PINNED_COLUMN,
  toggleColumn,
  type ColumnId,
} from "./tableColumns";

/**
 * Wave 5A — column picker ("Columns ▾"). Desktop renders
 * a popover; narrow renders a bottom sheet. `draft` is local until OK —
 * OK commits (`onCommit`), Cancel discards (`onCancel`). Search filters
 * the checkbox list without touching the draft; `num` is pinned (its
 * checkbox disabled) so at least one column always stays visible.
 */
export interface TaskColumnPickerProps {
  visible: ReadonlySet<ColumnId>;
  onCommit: (next: Set<ColumnId>) => void;
  onCancel: () => void;
  /** popover (true) vs bottom sheet (false) — driven by useIsWide */
  isWide?: boolean;
  /** Trigger element the popover anchors to (wide mode). */
  anchor?: HTMLElement | null;
}

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #c9cccd",
  borderRadius: 6,
  fontSize: 13,
  boxSizing: "border-box",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "3px 0",
  fontSize: 13,
};

export function TaskColumnPicker({
  visible,
  onCommit,
  onCancel,
  isWide = true,
  anchor = null,
}: TaskColumnPickerProps): JSX.Element {
  const [draft, setDraft] = useState<Set<ColumnId>>(() => new Set(visible));
  const [query, setQuery] = useState("");

  const list = filterColumns(query);

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
      <button
        type="button"
        className="ff-task-columns-cancel"
        onClick={onCancel}
        style={{ padding: "4px 12px", borderRadius: 6, border: "1px solid #c9cccd", background: "#fff", cursor: "pointer" }}
      >
        Cancel
      </button>
      <button
        type="button"
        className="ff-task-columns-ok"
        onClick={() => onCommit(draft)}
        style={{ padding: "4px 14px", borderRadius: 6, border: "none", background: "#1a73e8", color: "#fff", cursor: "pointer" }}
      >
        OK
      </button>
    </div>
  );

  const body = (
    <div
      className="ff-task-columns-picker"
      data-testid="ff-task-columns-picker"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#fff",
        border: "1px solid #e4e6e7",
        borderRadius: 8,
        boxShadow: "0 2px 10px rgba(0,0,0,0.16)",
        padding: 10,
        boxSizing: "border-box",
      }}
    >
      <input
        type="search"
        autoFocus
        placeholder="Search columns…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search columns"
        style={inputStyle}
      />
      <div style={{ marginTop: 8, overflowY: "auto", flex: "1 1 auto" }}>
        {list.map((c) => {
          const checked = draft.has(c.id);
          const pinned = c.id === PINNED_COLUMN;
          return (
            <label key={c.id} className="ff-task-columns-row" style={rowStyle}>
              <input
                type="checkbox"
                checked={checked}
                disabled={pinned}
                onChange={(e) => setDraft((d) => toggleColumn(d, c.id, e.target.checked))}
                data-testid={`columns-checkbox-${c.id}`}
              />
              <span style={{ color: pinned ? "#888" : "#202124" }}>{c.label}</span>
              {pinned && <span style={{ fontSize: 11, color: "#999" }}>(required)</span>}
            </label>
          );
        })}
        {list.length === 0 && (
          <div style={{ color: "#777", fontSize: 13, padding: "8px 0" }}>No columns match.</div>
        )}
      </div>
      {footer}
    </div>
  );

  if (isWide) {
    // Portal + viewport-aware placement: an in-flow absolute popover was
    // clipped by the toolbar's overflow-x scroll row.
    return (
      <AnchoredPopover
        anchor={anchor}
        open
        onClose={onCancel}
        align="end"
        width={260}
        ariaLabel="Choose columns"
        data-testid="ff-task-columns-popover"
      >
        {body}
      </AnchoredPopover>
    );
  }

  return (
    <div
      className="ff-task-columns-sheet"
      role="dialog"
      aria-label="Choose columns"
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        bottom: 0,
        maxHeight: "70vh",
        zIndex: 50,
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      {body}
    </div>
  );
}