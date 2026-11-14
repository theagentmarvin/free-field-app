import { useMemo, useState, type CSSProperties } from "react";

import { AnchoredPopover } from "./AnchoredPopover";

import type { ColumnId, TaskTableRow } from "./tableColumns";
import { getColumn } from "./tableColumns";
import {
  DATE_PRESETS,
  DATE_PRESET_LABELS,
  DEADLINE_PRESETS,
  DEADLINE_PRESET_LABELS,
  distinctOptions,
  emptyFilter,
  type ColumnFilter,
  type DeadlinePresetKey,
  type DatePresetKey,
} from "./columnFilters";

/**
 * Wave 10 — per-column filter popover. Registry-driven: the body is
 * chosen by `column.filterKind`. Checkbox/preset changes apply
 * IMMEDIATELY (through `onApply`) so the column filters live; contains
 * and number commit on Apply. The popover is positioned by the parent
 * (`left`/`top`, already clamped to the viewport). Escape closes.
 */
export interface TaskColumnFilterPopoverProps {
  colId: ColumnId;
  rows: readonly TaskTableRow[];
  filter?: ColumnFilter;
  /** Funnel button the popover anchors to. */
  anchor: HTMLElement | null;
  onApply: (next: ColumnFilter) => void;
  onClose: () => void;
}

const shellStyle: CSSProperties = {
  width: 260,
  background: "#fff",
  border: "1px solid #e4e6e7",
  borderRadius: 8,
  boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
  padding: 10,
  boxSizing: "border-box",
  fontSize: 13,
};

const chipStyle: CSSProperties = {
  padding: "3px 10px",
  borderRadius: 12,
  border: "1px solid #c9cccd",
  background: "#fff",
  color: "#333",
  cursor: "pointer",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const chipActiveStyle: CSSProperties = {
  ...chipStyle,
  background: "#1a73e8",
  borderColor: "#1a73e8",
  color: "#fff",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid #c9cccd",
  borderRadius: 6,
  fontSize: 13,
  boxSizing: "border-box",
};

function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function TaskColumnFilterPopover({
  colId,
  rows,
  filter,
  anchor,
  onApply,
  onClose,
}: TaskColumnFilterPopoverProps): JSX.Element | null {
  const col = getColumn(colId);
  const kind = col?.filterKind;

  const options = useMemo(
    () => (kind === "distinct" ? distinctOptions(rows, colId) : []),
    [kind, rows, colId]
  );

  const [query, setQuery] = useState(() =>
    filter?.kind === "contains" ? filter.query : ""
  );
  const [minText, setMinText] = useState(() =>
    filter?.kind === "number" && filter.min != null ? String(filter.min) : ""
  );
  const [maxText, setMaxText] = useState(() =>
    filter?.kind === "number" && filter.max != null ? String(filter.max) : ""
  );

  if (!kind) return null;

  const selectedKeys =
    filter?.kind === "distinct" ? filter.keys : ([] as readonly string[]);

  function toggleKey(key: string): void {
    const next = selectedKeys.includes(key)
      ? selectedKeys.filter((k) => k !== key)
      : [...selectedKeys, key];
    onApply({ kind: "distinct", keys: next });
  }

  function toggleAll(): void {
    const all = options.map((o) => o.key);
    const allSelected = all.length > 0 && all.every((k) => selectedKeys.includes(k));
    onApply({ kind: "distinct", keys: allSelected ? [] : all });
  }

  function togglePreset(key: string): void {
    const cur =
      filter && (filter.kind === "deadline" || filter.kind === "date")
        ? filter.presets
        : ([] as readonly string[]);
    const next = cur.includes(key)
      ? cur.filter((k) => k !== key)
      : [...cur, key];
    if (kind === "deadline") onApply({ kind: "deadline", presets: next as DeadlinePresetKey[] });
    else onApply({ kind: "date", presets: next as DatePresetKey[] });
  }

  function clearThis(): void {
    setQuery("");
    setMinText("");
    setMaxText("");
    onApply(emptyFilter(kind!));
  }

  function applyOnClose(): void {
    if (kind === "contains") onApply({ kind: "contains", query });
    else if (kind === "number")
      onApply({ kind: "number", min: parseNumber(minText), max: parseNumber(maxText) });
    onClose();
  }

  const footer = (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
      <button
        type="button"
        className="ff-task-filter-clear"
        onClick={clearThis}
        style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #c9cccd", background: "#fff", cursor: "pointer", fontSize: 13 }}
      >
        Clear
      </button>
      <button
        type="button"
        className="ff-task-filter-apply"
        onClick={applyOnClose}
        style={{ padding: "4px 14px", borderRadius: 6, border: "none", background: "#1a73e8", color: "#fff", cursor: "pointer", fontSize: 13 }}
      >
        Apply
      </button>
    </div>
  );

  let body: React.ReactNode;
  if (kind === "distinct") {
    const allSelected =
      options.length > 0 && options.every((o) => selectedKeys.includes(o.key));
    body = (
      <div style={{ maxHeight: 280, overflowY: "auto" }}>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontWeight: 600, cursor: "pointer" }}
        >
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          <span>(Select all)</span>
        </label>
        {options.map((o) => (
          <label
            key={o.key}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", cursor: "pointer" }}
            data-testid={`filter-option-${colId}-${o.key.replace(/\s+/g, "-")}`}
          >
            <input
              type="checkbox"
              checked={selectedKeys.includes(o.key)}
              onChange={() => toggleKey(o.key)}
              aria-label={o.label}
            />
            <span style={{ flex: "1 1 auto" }}>{o.label}</span>
            <span style={{ color: "#888", fontSize: 12 }}>{o.count}</span>
          </label>
        ))}
        {options.length === 0 && (
          <div style={{ color: "#777", padding: "8px 0" }}>No values to filter.</div>
        )}
      </div>
    );
  } else if (kind === "deadline" || kind === "date") {
    const presets: readonly string[] = kind === "deadline" ? DEADLINE_PRESETS : DATE_PRESETS;
    const labels = (kind === "deadline" ? DEADLINE_PRESET_LABELS : DATE_PRESET_LABELS) as Record<string, string>;
    const cur =
      filter && (filter.kind === "deadline" || filter.kind === "date")
        ? filter.presets
        : ([] as readonly string[]);
    body = (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {presets.map((p) => {
          const active = cur.includes(p);
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => togglePreset(p)}
              style={active ? chipActiveStyle : chipStyle}
            >
              {labels[p]}
            </button>
          );
        })}
      </div>
    );
  } else if (kind === "contains") {
    body = (
      <input
        type="search"
        placeholder="Contains…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            onApply({ kind: "contains", query });
          }
        }}
        aria-label={`Filter ${col?.label ?? colId}`}
        style={inputStyle}
        autoFocus
      />
    );
  } else {
    body = (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="number"
          placeholder="Min"
          value={minText}
          onChange={(e) => setMinText(e.target.value)}
          aria-label="Minimum"
          style={inputStyle}
        />
        <span style={{ color: "#888" }}>–</span>
        <input
          type="number"
          placeholder="Max"
          value={maxText}
          onChange={(e) => setMaxText(e.target.value)}
          aria-label="Maximum"
          style={inputStyle}
        />
      </div>
    );
  }

  return (
    <AnchoredPopover
      anchor={anchor}
      open
      onClose={onClose}
      align="start"
      ariaLabel={`Filter ${col?.label ?? colId}`}
      data-testid="ff-task-filter-popover"
    >
    <div className="ff-task-filter-popover" style={shellStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
          fontWeight: 600,
          color: "#202124",
        }}
      >
        <span>{col?.label ?? colId}</span>
      </div>
      {body}
      {footer}
    </div>
    </AnchoredPopover>
  );
}
