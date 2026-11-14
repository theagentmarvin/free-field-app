import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";

import type { TaskView, TaskVerb } from "@ff/tasks";

import type { PhotoUrlResolver } from "./usePhotoUrl";
import {
  TABLE_COLUMNS,
  loadVisibleColumns,
  saveVisibleColumns,
  sortRowsByColumn,
  type ColumnId,
  type SortDir,
  type TaskTableRow,
} from "./tableColumns";
import {
  applyColumnFilters,
  countActiveFilters,
  filterSelectionCount,
  isFilterEmpty,
  type ActiveFilters,
  type ColumnFilter,
} from "./columnFilters";
import { TaskColumnPicker } from "./TaskColumnPicker";
import { TaskColumnFilterPopover } from "./TaskColumnFilterPopover";
import { ToolbarButton } from "./TaskToolbar";
import { tokens, groupHeaderStyle, hoverActionStyle, softStatusDotStyle, statusAccent } from "./formStyles";
import { formatTaskNum, groupTasks, quickAdvanceVerb, type GroupKey } from "./logic";
import { rangeIds, toggleId } from "./bulkLogic";

/**
 * Wave 5A — task table (desktop). Sticky header, sticky
 * first column (num), header-click sort (asc → desc → none), a
 * "Columns ▾" picker, and the same row semantics as <TasksListPanel>:
 * pending rows striped + ⋯, failed rows ⚠ + retry, row click → onOpen.
 *
 * Wave 10 — per-column filter. Each header carries a funnel icon
 * (header click still sorts); the funnel opens a registry-driven
 * popover. Composition: status chips + global search are already
 * applied upstream, column filters run here (AND across, OR within),
 * then header sort. Filters are SESSION state only (never persisted).
 *
 * Phone keeps <TasksListPanel> cards via <TasksApp>'s useIsWide gate —
 * this component is the wide branch only.
 */

export interface TaskTablePanelProps {
  rows: readonly TaskTableRow[];
  now: number;
  onOpen?: (task: TaskView) => void;
  onRetry?: (task: TaskView) => void;
  emptyLabel?: string;
  /** host-supplied Storage resolver; absent → no thumbs, no broken imgs */
  resolvePhotoUrl?: PhotoUrlResolver;
  /** Wave 11 — when true the host (<TasksApp> header) renders the toolbar
   *  band (Clear filters + Columns + picker) and drives column visibility
   *  + session filters through the three props below. Standalone consumers
   *  keep the internal band + state (behavior unchanged). */
  hostToolbar?: boolean;
  columnsVisibility?: ReadonlySet<ColumnId>;
  columnFilters?: ActiveFilters;
  onColumnFiltersChange?: (next: ActiveFilters) => void;
  /** UI-refresh v1 §3 V4: group headers (Status · Building · Assignee);
   *  "none" = today's flat list. */
  groupBy?: GroupKey;
  /** V7 hover action ⌖ — open the pin in the viewer (host-gated; the
   *  button hides when the callback is absent). */
  onLocate?: (task: TaskView) => void;
  /** V7 hover action ✓ — quick status advance (verb computed by
   *  quickAdvanceVerb; behavior-frozen: same verb enqueue as detail). */
  onQuickAdvance?: (task: TaskView, verb: TaskVerb) => void;
  /** w69 — multi-select. When present a checkbox column leads the table
   *  (click = toggle, shift-click = range in display order). */
  selection?: { selected: ReadonlySet<string>; onChange: (next: Set<string>) => void };
  /** w69 — keyboard-focused row (J/K); scrolled into view + outlined. */
  activeId?: string | null;
  /** w69 — the ids in on-screen order (after filter/sort/group/window),
   *  reported so the host can drive J/K and select-all. */
  onDisplayedIdsChange?: (ids: string[]) => void;
  /** w69 — progressive rendering: rows painted per "page" (default 100).
   *  Keeps 1000+ row lists fast; more rows load on scroll or via the button. */
  pageSize?: number;
  /** w69 — the data feed has more rows than loaded (server-side page). */
  hasMoreRemote?: boolean;
  /** w69 — ask the host for the next server page. */
  onLoadMore?: () => void;
}

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "max-content",
  minWidth: "100%",
  fontSize: 13,
};

/** Height of the sticky thead — group headers stick just under it.
 *  thStyle pins `height: THEAD_HEIGHT` so the constant matches reality. */
const THEAD_HEIGHT = 34;

const thStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: "#f8f9fa",
  borderBottom: "1px solid #d9dcdf",
  textAlign: "left",
  padding: "6px 8px",
  // Deterministic header height so THEAD_HEIGHT matches reality —
  // sticky group headers sit flush under the thead (no see-through gap).
  height: THEAD_HEIGHT,
  boxSizing: "border-box",
  whiteSpace: "nowrap",
  fontWeight: 600,
  color: "#5f6368",
  cursor: "pointer",
  userSelect: "none",
};

const thStickyLeftStyle: CSSProperties = { ...thStyle, left: 0, zIndex: 3 };

const tdStyle: CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid #eee",
  whiteSpace: "nowrap",
  verticalAlign: "middle",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 320,
};

/** Uniform task-row height (2026-11-09 glitch fix): the assignee cell
 *  stacks a 22px avatar + name (~50px), but unassigned rows render a
 *  bare "—" and collapsed to ~28px — the first unassigned row looked
 *  "shorter than the rest". A tr-level min-height normalizes every row
 *  regardless of which cells carry tall content (avatars, thumbs). */
const ROW_HEIGHT = 50;

const tdStickyLeftStyle: CSSProperties = {
  ...tdStyle,
  position: "sticky",
  left: 0,
  zIndex: 1,
  background: "#fff",
  fontVariantNumeric: "tabular-nums",
};

/** Keyboard-focused row (J/K) tint — sticky cells repeat it. */
const ACTIVE_BG = "#e1ebfc";

/** Width of the leading checkbox column (and the sticky offset of `num`). */
const SELECT_COL = 40;

const selectCellStyle: CSSProperties = {
  ...tdStyle,
  position: "sticky",
  left: 0,
  zIndex: 1,
  background: "#fff",
  width: SELECT_COL,
  minWidth: SELECT_COL,
  padding: "0 0 0 12px",
};

const checkStyle: CSSProperties = { width: 16, height: 16, cursor: "pointer", accentColor: tokens.color.focusRing, margin: 0, verticalAlign: "middle" };

const SORT_GLYPH: Record<SortDir, string> = { asc: " ▲", desc: " ▼", none: "" };

function FunnelGlyph({ active }: { active: boolean }): JSX.Element {
  return (
    <svg width="13" height="12" viewBox="0 0 18 12" aria-hidden="true" style={{ display: "block" }}>
      {active ? (
        <path d="M0 0h18l-7 8v3l-4 2v-5L0 0z" fill="#1a73e8" />
      ) : (
        <path d="M0 0h18l-7 8v3l-4 2v-5L0 0z" fill="none" stroke="#5f6368" strokeWidth={1.6} />
      )}
    </svg>
  );
}

interface OpenFilter {
  colId: ColumnId;
  anchor: HTMLElement;
}

export function TaskTablePanel({
  rows,
  now,
  onOpen,
  onRetry,
  emptyLabel = "No tasks yet.",
  resolvePhotoUrl,
  hostToolbar = false,
  columnsVisibility,
  columnFilters,
  onColumnFiltersChange,
  groupBy = "none",
  onLocate,
  onQuickAdvance,
  selection,
  activeId = null,
  onDisplayedIdsChange,
  pageSize = 100,
  hasMoreRemote = false,
  onLoadMore,
}: TaskTablePanelProps): JSX.Element {
  const [internalVisible, setInternalVisible] = useState<ReadonlySet<ColumnId>>(() => loadVisibleColumns());
  const [sort, setSort] = useState<{ colId: ColumnId; dir: SortDir }>({ colId: "updatedAt", dir: "none" });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [columnsBtn, setColumnsBtn] = useState<HTMLElement | null>(null);
  const [internalFilters, setInternalFilters] = useState<ActiveFilters>({});
  const [openFilter, setOpenFilter] = useState<OpenFilter | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [hoverRow, setHoverRow] = useState<string | null>(null);

  const visible = hostToolbar && columnsVisibility ? columnsVisibility : internalVisible;
  const filters = hostToolbar && columnFilters ? columnFilters : internalFilters;

  /** Session filters, single write path: hosted → host state; standalone → internal. */
  function updateFilters(next: ActiveFilters): void {
    if (hostToolbar && onColumnFiltersChange) onColumnFiltersChange(next);
    else setInternalFilters(next);
  }

  const visibleColumns = useMemo(
    () => TABLE_COLUMNS.filter((c) => visible.has(c.id)),
    [visible]
  );

  const filtered = useMemo(
    () => applyColumnFilters(rows, filters, now),
    [rows, filters, now]
  );

  const sorted = useMemo(
    () => sortRowsByColumn(filtered, sort.colId, sort.dir, now),
    [filtered, sort.colId, sort.dir, now]
  );

  const activeFilterCount = useMemo(() => countActiveFilters(filters), [filters]);

  // Progressive rendering window (w69): paint `renderLimit` rows; the
  // sentinel below the table (or the button) widens it. Resets when the
  // filtered set shrinks below the window so a new search starts light.
  const [renderLimit, setRenderLimit] = useState(pageSize);
  useEffect(() => {
    setRenderLimit((n) => (sorted.length < n ? Math.max(pageSize, Math.min(n, sorted.length)) : n));
  }, [sorted.length, pageSize]);
  const windowed = useMemo(() => sorted.slice(0, renderLimit), [sorted, renderLimit]);
  const moreLocal = sorted.length > renderLimit;
  const canLoadMore = moreLocal || (hasMoreRemote && !!onLoadMore);
  const loadMore = (): void => {
    if (moreLocal) setRenderLimit((n) => n + pageSize);
    else onLoadMore?.();
  };
  const loadMoreRef = useRef(loadMore);
  loadMoreRef.current = loadMore;
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !canLoadMore || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMoreRef.current();
    }, { rootMargin: "240px" });
    io.observe(el);
    return () => io.disconnect();
  }, [canLoadMore, renderLimit, sorted.length]);

  function onHeaderClick(id: ColumnId): void {
    setSort((s) => {
      if (s.colId !== id) return { colId: id, dir: "asc" };
      const dir: SortDir = s.dir === "asc" ? "desc" : s.dir === "desc" ? "none" : "asc";
      return { colId: id, dir };
    });
  }

  function onFunnelClick(e: MouseEvent<HTMLButtonElement>, id: ColumnId): void {
    e.stopPropagation();
    const el = e.currentTarget;
    setOpenFilter((cur) => (cur?.colId === id ? null : { colId: id, anchor: el }));
  }

  function applyFilter(colId: ColumnId, next: ColumnFilter): void {
    updateFilters({ ...filters, [colId]: next });
  }

  function clearAllFilters(): void {
    updateFilters({});
  }

  function commitColumns(next: Set<ColumnId>): void {
    setInternalVisible(next);
    saveVisibleColumns(next);
    setPickerOpen(false);
  }

  function onRetryClick(e: MouseEvent, task: TaskView): void {
    e.stopPropagation();
    onRetry?.(task);
  }

  function toggleGroup(key: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const rowNode = (t: TaskTableRow): JSX.Element => {
    const pending = t.pending && !t.failed;
    const striped = pending ? "repeating-linear-gradient(45deg, #f7f9fa 0, #f7f9fa 6px, #fff 6px, #fff 12px)" : undefined;
    const hovered = hoverRow === t.id;
    const qv = quickAdvanceVerb(t.status);
    const isSelected = !!selectedSet?.has(t.id);
    const isActive = activeId === t.id;
    return (
      <tr
        key={t.id}
        ref={isActive ? activeRowRef : undefined}
        aria-selected={selection ? isSelected : undefined}
        data-active={isActive ? "true" : undefined}
        className={[
          "ff-task-table-row",
          t.pending ? "ff-task-row--pending" : "",
          t.failed ? "ff-task-row--failed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          cursor: onOpen ? "pointer" : "default",
          opacity: pending ? 0.6 : 1,
          height: ROW_HEIGHT,
          background: striped ?? (isActive ? ACTIVE_BG : isSelected ? tokens.color.focusRingTint : hovered ? tokens.color.surface2 : undefined),
        }}
        onClick={(e) => {
          // Ctrl/Cmd-click toggles, Shift-click ranges (when selecting is on);
          // a plain click still opens the detail.
          if (selection && (e.ctrlKey || e.metaKey || (e.shiftKey && anchorRef.current))) {
            e.preventDefault();
            toggleRow(t.id, e.shiftKey);
            return;
          }
          onOpen?.(t);
        }}
        onMouseEnter={() => setHoverRow(t.id)}
        onMouseLeave={() => setHoverRow((h) => (h === t.id ? null : h))}
        aria-label={t.title}
      >
        {selection && (
          <td style={{ ...selectCellStyle, background: isActive ? ACTIVE_BG : isSelected ? "#eef3fd" : "#fff", boxShadow: isActive ? `inset 3px 0 0 ${tokens.color.focusRing}` : undefined }} onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="ff-task-row-check"
              data-testid={`row-check-${t.id}`}
              aria-label={`Select ${formatTaskNum(t.num)} ${t.title}`}
              checked={isSelected}
              onChange={() => undefined}
              onClick={(e) => {
                e.stopPropagation();
                toggleRow(t.id, e.shiftKey);
              }}
              style={checkStyle}
            />
          </td>
        )}
        {visibleColumns.map((c) => (
          <td key={c.id} title={c.id === "title" ? t.title : undefined} style={c.id === "num" ? { ...tdStickyLeftStyle, left: selection ? SELECT_COL : 0, background: isActive ? ACTIVE_BG : isSelected ? "#eef3fd" : "#fff", boxShadow: isActive && !selection ? `inset 3px 0 0 ${tokens.color.focusRing}` : undefined } : tdStyle}>
            {c.render ? c.render(t, { now, resolvePhotoUrl }) : null}
          </td>
        ))}
        <td className="ff-task-table-actions" style={{ ...tdStyle, textAlign: "right" }}>
          {t.failed && (
            <button
              type="button"
              className="ff-task-retry"
              aria-label="Retry failed action"
              style={{ border: `1px solid ${tokens.color.danger}`, color: tokens.color.danger, background: "white", borderRadius: 6, padding: "2px 8px", cursor: "pointer" }}
              onClick={(e) => onRetryClick(e, t)}
            >
              ⚠ retry
            </button>
          )}
          {pending && <span style={{ color: tokens.color.muted }}>⋯</span>}
          {/* V7 hover actions: ⌖ open in viewer · ✓ quick advance · ⋯ detail */}
          {!pending && hovered && (
            <span className="ff-task-row-hover-actions" style={{ display: "inline-flex", gap: 2 }}>
              {onLocate && (
                <button
                  type="button"
                  className="ff-task-hover-locate"
                  aria-label={`Locate ${t.title} in viewer`}
                  title="Open in viewer"
                  style={hoverActionStyle}
                  onClick={(e) => {
                    e.stopPropagation();
                    onLocate(t);
                  }}
                >
                  ⌖
                </button>
              )}
              {onQuickAdvance && qv && (
                <button
                  type="button"
                  className="ff-task-hover-advance"
                  aria-label={`Quick ${qv}: ${t.title}`}
                  title={qv === "approve" ? "Approve" : "Mark complete"}
                  style={hoverActionStyle}
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickAdvance(t, qv);
                  }}
                >
                  ✓
                </button>
              )}
              <button
                type="button"
                className="ff-task-hover-more"
                aria-label={`Open ${t.title}`}
                title="Open detail"
                style={hoverActionStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen?.(t);
                }}
              >
                ⋯
              </button>
            </span>
          )}
          {!t.failed && !pending && !hovered && <span style={{ color: tokens.color.border }}>·</span>}
        </td>
      </tr>
    );
  };

  const groups = groupBy === "none" ? null : groupTasks(windowed, groupBy);

  const displayedIds = useMemo(
    () =>
      groups
        ? groups.filter((g) => !collapsed.has(g.key)).flatMap((g) => g.rows.map((r) => r.id))
        : windowed.map((r) => r.id),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowed, groupBy, collapsed]
  );
  const idsKey = displayedIds.join("\u0001");
  useEffect(() => {
    onDisplayedIdsChange?.(displayedIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const anchorRef = useRef<string | null>(null);
  const selectedSet = selection?.selected;
  function toggleRow(id: string, shift: boolean): void {
    if (!selection) return;
    if (shift && anchorRef.current) {
      const next = new Set(selection.selected);
      for (const x of rangeIds(displayedIds, anchorRef.current, id)) next.add(x);
      selection.onChange(next);
    } else {
      selection.onChange(toggleId(selection.selected, id));
    }
    anchorRef.current = id;
  }
  const allSelected = !!selectedSet && displayedIds.length > 0 && displayedIds.every((id) => selectedSet.has(id));
  const someSelected = !!selectedSet && displayedIds.some((id) => selectedSet.has(id));
  const headCheckRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headCheckRef.current) headCheckRef.current.indeterminate = !allSelected && someSelected;
  }, [allSelected, someSelected]);
  const activeRowRef = useRef<HTMLTableRowElement | null>(null);
  useEffect(() => {
    activeRowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);

  if (rows.length === 0) {
    return (
      <div
        className="ff-tasks-empty"
        role="status"
        style={{ padding: "48px 24px", color: tokens.color.muted, textAlign: "center", fontSize: 14, lineHeight: 1.5 }}
      >
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="ff-task-table-wrap" style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {!hostToolbar && (
        <div
          className="ff-task-table-toolbar"
          style={{
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: tokens.space.s2,
            padding: `6px ${tokens.space.s3}px`,
            background: tokens.color.surface,
            borderBottom: `1px solid ${tokens.color.border}`,
            boxSizing: "border-box",
            flexWrap: "wrap",
          }}
        >
          {activeFilterCount > 0 && (
            <ToolbarButton
              className="ff-task-clear-filters"
              ariaLabel="Clear filters"
              onClick={clearAllFilters}
            >
              Clear filters ({activeFilterCount})
            </ToolbarButton>
          )}
          <ToolbarButton
            className="ff-task-columns-button"
            ariaLabel="Choose columns"
            ariaExpanded={pickerOpen}
            buttonRef={setColumnsBtn}
            onClick={() => setPickerOpen((o) => !o)}
          >
            Columns ▾
          </ToolbarButton>
          {pickerOpen && (
            <TaskColumnPicker
              visible={visible}
              onCommit={commitColumns}
              onCancel={() => setPickerOpen(false)}
              isWide
              anchor={columnsBtn}
            />
          )}
        </div>
      )}

      <div className="ff-task-table-scroll" style={{ flex: "1 1 auto", overflow: "auto" }}>
        <table className="ff-task-table" style={tableStyle} role="table">
          <colgroup>
            {selection && <col style={{ width: SELECT_COL }} />}
            {visibleColumns.map((c) => (
              <col key={c.id} style={c.width ? { width: c.width } : { minWidth: 180 }} />
            ))}
            <col style={{ width: 90 }} />
          </colgroup>
          <thead>
            <tr>
              {selection && (
                <th scope="col" style={{ ...thStickyLeftStyle, width: SELECT_COL, padding: "0 0 0 12px", cursor: "default" }}>
                  <input
                    type="checkbox"
                    ref={headCheckRef}
                    className="ff-task-select-all"
                    data-testid="select-all"
                    aria-label={allSelected ? "Deselect all tasks" : "Select all tasks"}
                    checked={allSelected}
                    onChange={() => {
                      const next = new Set(selection.selected);
                      if (allSelected) for (const id of displayedIds) next.delete(id);
                      else for (const id of displayedIds) next.add(id);
                      selection.onChange(next);
                    }}
                    style={checkStyle}
                  />
                </th>
              )}
              {visibleColumns.map((c) => {
                const active =
                  c.filterKind !== undefined && !isFilterEmpty(filters[c.id]);
                const selCount = filterSelectionCount(filters[c.id]);
                return (
                  <th
                    key={c.id}
                    scope="col"
                    data-testid={`th-${c.id}`}
                    aria-sort={sort.colId === c.id && sort.dir !== "none" ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    onClick={() => onHeaderClick(c.id)}
                    style={c.id === "num" ? { ...thStickyLeftStyle, left: selection ? SELECT_COL : 0 } : thStyle}
                  >
                    <span className="ff-task-th-inner" style={{ display: "inline-flex", alignItems: "center", gap: 4, width: "100%" }}>
                      <span className="ff-task-th-label" style={{ flex: "1 1 auto" }}>
                        {c.label}
                        {sort.colId === c.id ? SORT_GLYPH[sort.dir] : ""}
                      </span>
                      {c.filterKind !== undefined && (
                        <button
                          type="button"
                          className="ff-task-filter-funnel"
                          data-testid={`filter-funnel-${c.id}`}
                          aria-label={`Filter ${c.label}`}
                          aria-expanded={openFilter?.colId === c.id}
                          onClick={(e) => onFunnelClick(e, c.id)}
                          style={{
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            padding: "2px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 2,
                          }}
                        >
                          <FunnelGlyph active={active} />
                          {active && selCount > 0 && (
                            <span
                              className="ff-task-filter-count"
                              style={{ fontSize: 10, color: "#1a73e8", fontWeight: 700 }}
                            >
                              {selCount}
                            </span>
                          )}
                        </button>
                      )}
                    </span>
                  </th>
                );
              })}
              <th scope="col" aria-label="actions" style={thStyle} />
            </tr>
          </thead>
          <tbody>
            {groups
              ? groups.map((g) => {
                  const isCollapsed = collapsed.has(g.key);
                  return (
                    <Fragment key={`group-${g.key}`}>
                      <tr className="ff-task-group-header-row" data-testid={`group-header-${g.key}`} aria-label={`Group ${g.label}`}>
                        <td
                          colSpan={visibleColumns.length + 1 + (selection ? 1 : 0)}
                          style={{ ...groupHeaderStyle, top: THEAD_HEIGHT, left: 0 }}
                          onClick={() => toggleGroup(g.key)}
                        >
                          <span
                            aria-hidden
                            style={{ ...softStatusDotStyle, background: g.key === "status" || /^\d+$/.test(g.key) ? statusAccent(Number(g.key)).bg : tokens.color.borderStrong, marginRight: 7, verticalAlign: "middle" }}
                          />
                          {g.label}
                          {" · "}{g.rows.length}
                          <span aria-hidden style={{ marginLeft: 6 }}>{isCollapsed ? "▸" : "▾"}</span>
                        </td>
                      </tr>
                      {!isCollapsed && g.rows.map(rowNode)}
                    </Fragment>
                  );
                })
              : windowed.map(rowNode)}
          </tbody>
        </table>
        <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />
      </div>
      <div
        className="ff-task-table-footer"
        data-testid="table-footer"
        role="status"
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: tokens.space.s3,
          padding: "6px 12px",
          fontSize: tokens.fontSize.sm,
          color: tokens.color.text2,
          borderTop: `1px solid ${tokens.color.border}`,
          background: tokens.color.surface2,
        }}
      >
        <span data-testid="table-count">
          {sorted.length === 0
            ? "No tasks match the filters"
            : `Showing ${Math.min(renderLimit, sorted.length)} of ${sorted.length}${hasMoreRemote ? "+" : ""} task${sorted.length === 1 ? "" : "s"}`}
        </span>
        {canLoadMore && (
          <button
            type="button"
            className="ff-task-load-more"
            data-testid="load-more"
            onClick={loadMore}
            style={{ border: `1px solid ${tokens.color.borderStrong}`, background: tokens.color.surface, color: tokens.color.focusRingInk, borderRadius: tokens.radius.md, padding: "3px 12px", fontWeight: 700, fontSize: tokens.fontSize.sm, cursor: "pointer", fontFamily: "inherit" }}
          >
            Load more
          </button>
        )}
      </div>

      {openFilter && (
        <>
          <TaskColumnFilterPopover
            key={openFilter.colId}
            colId={openFilter.colId}
            rows={rows}
            filter={filters[openFilter.colId]}
            anchor={openFilter.anchor}
            onApply={(next) => applyFilter(openFilter.colId, next)}
            onClose={() => setOpenFilter(null)}
          />
        </>
      )}
    </div>
  );
}