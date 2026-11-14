import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";

import {
  kbdHintStyle,
  scopeChipStyle,
  segmentItemStyle,
  segmentedPillStyle,
  toolbarBandStyle,
  toolbarChipActiveStyle,
  toolbarChipStyle,
  toolbarControlStyle,
  toolbarInputStyle,
  toolbarPrimaryControlStyle,
  toolbarSubBandStyle,
  toolbarTitleStyle,
  tokens,
} from "./formStyles";
import { AnchoredPopover } from "./AnchoredPopover";
import type { Chip, GroupKey, QuickFilters, SavedView, ScopeMode, SortKey, ViewMode } from "./logic";
import { GROUP_OPTIONS } from "./logic";

/**
 * Wave 11 — the tasks toolbar band (the <TasksApp> header).
 *
 * Maintainer call (2026-11-03): the old header was five defects — a clipped
 * "+ New task", a Columns button wrapping onto a stray line, a
 * truncating search, three styling islands (filled / outline / bare
 * native), and chips cramped against the title. This is ONE coherent
 * toolbar built from the `formStyles.ts` token family:
 *
 * · every control shares the 36px `toolbarControlStyle` family (height,
 *   `radius.md`, `borderStrong` hairline, token font, hover/active/
 *   focus states); "+ New task" is the ONLY filled primary;
 * · wide (≥1100px, `singleRow`): one row — title, chips, then the
 *   right-aligned action cluster [search · sort · (Clear filters) ·
 *   Columns · + New task];
 * · narrower: chips keep their own horizontally scrollable row (never
 *   a stray wrap), the action row stays intact below it;
 * · chips keep exact active/inactive semantics + `aria-pressed`, with
 *   the tinted-accent pill language of the filter-popover chips.
 *
 * Behavior contract: every handler / `aria-label` / class name /
 * keyboard path from the old inline header lives here unchanged — the
 * logic (chip/search/sort state, outbox, compose) stays in <TasksApp>.
 */

const { color: c, space: s, fontSize: f } = tokens;

/** Status filter chips — moved verbatim from <TasksApp> (same ids). */
export const TOOLBAR_CHIPS: ReadonlyArray<{ id: Chip; label: string }> = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: 10, label: "Inbox" },
  { id: 20, label: "Ongoing" },
  { id: 40, label: "Awaiting" },
  { id: 60, label: "Follow-up" },
  { id: "closed", label: "Closed" },
];

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "updated", label: "Updated" },
  { value: "deadline", label: "Deadline" },
  { value: "created", label: "Created" },
];

const FOCUS_RING: CSSProperties = { boxShadow: `0 0 0 3px ${tokens.color.focusRingLine}` };

// ── control-family primitives ─────────────────────────────────────────────

export interface ToolbarButtonProps {
  children: ReactNode;
  onClick: () => void;
  /** "primary" = the bar's only filled control (+ New task). */
  kind?: "secondary" | "primary";
  className?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  ariaExpanded?: boolean;
  /** Callback ref to the underlying <button> (popover anchor). */
  buttonRef?: (el: HTMLButtonElement | null) => void;
  style?: CSSProperties;
}

export function ToolbarButton({
  children,
  onClick,
  kind = "secondary",
  className,
  ariaLabel,
  ariaPressed,
  ariaExpanded,
  buttonRef,
  style,
}: ToolbarButtonProps): JSX.Element {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [press, setPress] = useState(false);
  const primary = kind === "primary";
  const base = primary ? toolbarPrimaryControlStyle : toolbarControlStyle;
  const dyn: CSSProperties = primary
    ? {
        background: hover || press ? tokens.color.primaryHover : tokens.color.primary,
        borderColor: hover || press ? tokens.color.primaryHover : tokens.color.primary,
        transform: press ? "translateY(1px)" : undefined,
      }
    : {
        background: hover || press ? c.surface2 : c.surface,
        borderColor: focus ? c.focusRing : hover ? c.focusRingLine : c.borderStrong,
        color: hover ? c.text : c.text2,
        transform: press ? "translateY(1px)" : undefined,
      };
  return (
    <button
      type="button"
      ref={buttonRef}
      className={className}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaExpanded === undefined ? undefined : "dialog"}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setPress(false);
      }}
      onMouseDown={() => setPress(true)}
      onMouseUp={() => setPress(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => {
        setFocus(false);
        setPress(false);
      }}
      style={{ ...base, ...dyn, ...(focus ? FOCUS_RING : null), ...style }}
    >
      {children}
    </button>
  );
}

export interface ToolbarChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  /** w69: number of tasks the chip would show (rendered as a small badge). */
  count?: number;
  /** w69: independent toggle (quick filter) instead of a radio-like chip. */
  testId?: string;
}

/** Status filter chip — token pill, tinted-accent when active, exact
 *  `ff-task-chip` class + `aria-pressed` semantics as before. */
export function ToolbarChip({ label, active, onPress, count, testId }: ToolbarChipProps): JSX.Element {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const base = active ? toolbarChipActiveStyle : toolbarChipStyle;
  const dyn: CSSProperties = {
    background: active ? (hover ? "rgba(47,111,228,0.14)" : c.focusRingTint) : hover ? c.focusRingTint : c.surface,
    color: active ? c.focusRingInk : hover ? c.text : c.text2,
    borderColor: focus ? c.focusRing : active ? c.focusRingLine : hover ? c.focusRingLine : c.borderStrong,
  };
  return (
    <button
      type="button"
      className={`ff-task-chip${active ? " ff-task-chip--active" : ""}`}
      aria-pressed={active}
      title={count === undefined ? undefined : `${label}: ${count} task${count === 1 ? "" : "s"}`}
      data-testid={testId}
      onClick={onPress}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{ ...base, ...dyn, gap: 6, ...(focus ? FOCUS_RING : null) }}
    >
      {label}
      {count !== undefined && (
        <span
          aria-hidden
          data-testid={testId ? `${testId}-count` : undefined}
          className="ff-task-chip-count"
          style={{ fontSize: f.xs, fontWeight: 700, minWidth: 16, padding: "1px 5px", borderRadius: 999, background: active ? "rgba(47,111,228,0.16)" : c.surface2, border: `1px solid ${active ? "transparent" : c.border}`, color: active ? c.focusRingInk : c.muted, lineHeight: 1.2 }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

export interface ToolbarSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  /** V9 — the ⌘K-styled trigger: cosmetic hint badge + Cmd/Ctrl+K
   *  focus trap (no palette yet — spec §3 V9 keeps v1 chrome-only). */
  kbdHint?: string;
}

export function ToolbarSearchInput({ value, onChange, placeholder, ariaLabel, kbdHint = "⌘K" }: ToolbarSearchInputProps): JSX.Element {
  const [focus, setFocus] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <span style={{ position: "relative", display: "inline-flex", flex: "1 1 240px", minWidth: 180, maxWidth: 360 }}>
      <input
        ref={inputRef}
        type="search"
        className="ff-task-search"
        placeholder={placeholder}
        value={value}
        aria-label={ariaLabel}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          ...toolbarInputStyle,
          flex: "1 1 auto",
          minWidth: 0,
          maxWidth: "none",
          paddingRight: 44,
          borderColor: focus ? c.focusRing : c.borderStrong,
          ...(focus ? FOCUS_RING : null),
        }}
      />
      {!value && (
        <kbd data-testid="ff-task-search-kbd" style={kbdHintStyle} aria-hidden="true">
          {kbdHint}
        </kbd>
      )}
    </span>
  );
}

export interface ToolbarSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  ariaLabel: string;
}

/** Keyboard-native <select> visually matched to the control family
 *  (appearance:none + token ▾). Options/logic untouched. */
export function ToolbarSelect({ value, onChange, options, ariaLabel }: ToolbarSelectProps): JSX.Element {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
      <select
        aria-label={ariaLabel}
        className="ff-task-sort"
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          ...toolbarControlStyle,
          appearance: "none",
          WebkitAppearance: "none",
          paddingRight: 30,
          background: hover ? c.surface2 : c.surface,
          borderColor: focus ? c.focusRing : hover ? c.focusRingLine : c.borderStrong,
          ...(focus ? FOCUS_RING : null),
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          right: 11,
          top: "50%",
          transform: "translateY(-50%)",
          color: c.muted,
          fontSize: f.sm,
          pointerEvents: "none",
        }}
      >
        ▾
      </span>
    </span>
  );
}

// ── the band itself ───────────────────────────────────────────────────────

export interface TaskToolbarProps {
  chip: Chip;
  onChipChange: (chip: Chip) => void;
  search: string;
  onSearchChange: (value: string) => void;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
  /** queued outbox actions; > 0 shows the ⇅ control */
  queued: number;
  onOpenOutbox: () => void;
  /** engine ready → the primary + New task is available */
  canCreate: boolean;
  onCreate: () => void;
  /** ≥1100px: one row; narrower: chips row above the action row */
  singleRow: boolean;
  /** table mode with rows (or live column filters) → Columns/Clear show */
  showColumnTools: boolean;
  /** Columns picker only applies to the table view; Clear filters shows in both. Default true. */
  showColumnsButton?: boolean;
  activeFilterCount: number;
  onClearFilters: () => void;
  columnsOpen: boolean;
  onToggleColumns: () => void;
  /** the <TaskColumnPicker> element, rendered anchored under Columns */
  columnsPicker?: (anchor: HTMLElement | null) => ReactNode;
  /** UI refresh v1 — the sub-band (§1 layout, §2 scope, V2/V4/V8). ALL
   *  optional: without them the toolbar renders exactly as wave 11. */
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  scope?: ScopeMode;
  onScopeChange?: (scope: ScopeMode) => void;
  /** rail building name for the scope chip (⌒ NORTH TOWER ▾) */
  buildingName?: string | null;
  groupBy?: GroupKey;
  onGroupByChange?: (group: GroupKey) => void;
  savedViews?: readonly SavedView[];
  activeViewId?: string | null;
  onSelectView?: (id: string | null) => void;
  /** w69 — counts per status chip (keys: "all" | "open" | "closed" | status id). */
  chipCounts?: Record<string, number>;
  /** w69 — quick filters ("My tasks" / "Overdue") with live counts. */
  quick?: QuickFilters;
  onQuickChange?: (next: QuickFilters) => void;
  quickCounts?: { mine: number; overdue: number };
  /** w69 — export of the current filtered view (CSV · PDF report). */
  onExportCsv?: () => void;
  onExportPdf?: () => void;
  exportCount?: number;
  /** w69 — opens the keyboard cheat-sheet. */
  onShowShortcuts?: () => void;
}

export function TaskToolbar({
  chip,
  onChipChange,
  search,
  onSearchChange,
  sort,
  onSortChange,
  queued,
  onOpenOutbox,
  canCreate,
  onCreate,
  singleRow,
  showColumnTools,
  showColumnsButton = true,
  activeFilterCount,
  onClearFilters,
  columnsOpen,
  onToggleColumns,
  columnsPicker,
  viewMode,
  onViewModeChange,
  scope,
  onScopeChange,
  buildingName = null,
  groupBy,
  onGroupByChange,
  savedViews,
  activeViewId = null,
  onSelectView,
  chipCounts,
  quick,
  onQuickChange,
  quickCounts,
  onExportCsv,
  onExportPdf,
  exportCount = 0,
  onShowShortcuts,
}: TaskToolbarProps): JSX.Element {
  const [viewsOpen, setViewsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBtn, setExportBtn] = useState<HTMLElement | null>(null);
  const [columnsBtn, setColumnsBtn] = useState<HTMLElement | null>(null);
  const [viewsBtn, setViewsBtn] = useState<HTMLElement | null>(null);
  const hasSubBand =
    viewMode !== undefined ||
    scope !== undefined ||
    groupBy !== undefined ||
    savedViews !== undefined ||
    quick !== undefined;

  return (
    <header
      className="ff-task-toolbar"
      style={{ ...toolbarBandStyle, position: "relative", zIndex: 5, flexDirection: "column", alignItems: "stretch", gap: 0, padding: 0 }}
    >
      <div style={{ ...toolbarBandStyle, borderBottom: hasSubBand ? "none" : `1px solid ${c.border}` }}>
      {/* title + chips (their own horizontally scrollable row when tight) */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: s.s2,
          flex: singleRow ? "0 1 auto" : "1 0 100%",
          minWidth: 0,
        }}
      >
        <strong style={toolbarTitleStyle}>Tasks</strong>
        <div
          className="ff-task-chips-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: s.s1 + 2,
            flex: "1 1 auto",
            minWidth: 0,
            overflowX: "auto",
            scrollbarWidth: "thin",
            paddingBottom: 2,
          }}
        >
          {TOOLBAR_CHIPS.map((ch) => (
            <ToolbarChip
              key={String(ch.id)}
              label={ch.label}
              active={chip === ch.id}
              count={chipCounts?.[String(ch.id)]}
              testId={chipCounts ? `chip-${String(ch.id)}` : undefined}
              onPress={() => onChipChange(ch.id)}
            />
          ))}
        </div>
      </div>

      {/* right-aligned action cluster — NEVER wraps a control onto a stray
          line (nowrap inside; horizontal scroll only if the row itself
          can't fit), and NEVER clips (+ New task included). */}
      <div
        className="ff-task-actions"
        style={{
          display: "flex",
          alignItems: "center",
          flexWrap: "nowrap",
          gap: s.s2,
          flex: singleRow ? "1 1 auto" : "1 1 100%",
          minWidth: 0,
          justifyContent: "flex-end",
          overflowX: "auto",
          scrollbarWidth: "thin",
        }}
      >
        <ToolbarSearchInput
          value={search}
          onChange={onSearchChange}
          placeholder="Search title, number, assignee…"
          ariaLabel="Search tasks"
        />
        <ToolbarSelect
          value={sort}
          onChange={(v) => onSortChange(v as SortKey)}
          options={SORT_OPTIONS}
          ariaLabel="Sort tasks"
        />
        {queued > 0 && (
          <ToolbarButton
            className="ff-task-outbox-chip"
            ariaLabel={`${queued} queued actions`}
            onClick={onOpenOutbox}
          >
            ⇅ {queued} queued
          </ToolbarButton>
        )}
        {showColumnTools && activeFilterCount > 0 && (
          <ToolbarButton className="ff-task-clear-filters" ariaLabel="Clear filters" onClick={onClearFilters}>
            Clear filters ({activeFilterCount})
          </ToolbarButton>
        )}
        {showColumnTools && showColumnsButton && (
          <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
            <ToolbarButton
              className="ff-task-columns-button"
              ariaLabel="Choose columns"
              ariaExpanded={columnsOpen}
              buttonRef={setColumnsBtn}
              onClick={onToggleColumns}
            >
              Columns ▾
            </ToolbarButton>
            {columnsOpen && columnsPicker && columnsPicker(columnsBtn)}
          </span>
        )}
        {(onExportCsv || onExportPdf) && (
          <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
            <ToolbarButton
              className="ff-task-export-button"
              ariaLabel="Export tasks"
              ariaExpanded={exportOpen}
              buttonRef={setExportBtn}
              onClick={() => setExportOpen((o) => !o)}
            >
              Export ▾
            </ToolbarButton>
            <AnchoredPopover
              anchor={exportBtn}
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              align="end"
              role="menu"
              ariaLabel="Export"
              minWidth={220}
            >
              <div
                className="ff-task-export-menu"
                style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: tokens.radius.md, boxShadow: tokens.shadow.raised, padding: 4, display: "flex", flexDirection: "column", gap: 2 }}
              >
                <div style={{ padding: "6px 10px", fontSize: f.xs, color: c.muted, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  Current view · {exportCount} task{exportCount === 1 ? "" : "s"}
                </div>
                {onExportCsv && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="export-csv"
                    disabled={exportCount === 0}
                    onClick={() => {
                      setExportOpen(false);
                      onExportCsv();
                    }}
                    style={{ ...toolbarControlStyle, height: 32, justifyContent: "flex-start", width: "100%", border: "none", background: "transparent", opacity: exportCount === 0 ? 0.5 : 1 }}
                  >
                    Download CSV
                  </button>
                )}
                {onExportPdf && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="export-pdf"
                    disabled={exportCount === 0}
                    onClick={() => {
                      setExportOpen(false);
                      onExportPdf();
                    }}
                    style={{ ...toolbarControlStyle, height: 32, justifyContent: "flex-start", width: "100%", border: "none", background: "transparent", opacity: exportCount === 0 ? 0.5 : 1 }}
                  >
                    PDF report (with photos)
                  </button>
                )}
              </div>
            </AnchoredPopover>
          </span>
        )}
        {onShowShortcuts && (
          <ToolbarButton className="ff-task-shortcuts-button" ariaLabel="Keyboard shortcuts" onClick={onShowShortcuts}>
            ?
          </ToolbarButton>
        )}
        {canCreate && (
          <ToolbarButton className="ff-task-new" kind="primary" onClick={onCreate}>
            + New task
          </ToolbarButton>
        )}
      </div>
      </div>

      {/* ── UI refresh v1 sub-band: Table·Board pill · scope chip +
          This/All toggle · Views ▾ · Group ▾ ─────────────────────── */}
      {hasSubBand && (
        <div className="ff-task-sub-band" style={{ ...toolbarSubBandStyle, borderTop: `1px solid ${c.border}`, minWidth: 0, width: "100%" }}>
          {viewMode && onViewModeChange && (
            <span role="radiogroup" aria-label="Task view" style={segmentedPillStyle}>
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "table"}
                className="ff-task-view-tab"
                data-testid="view-tab-table"
                onClick={() => onViewModeChange("table")}
                style={segmentItemStyle(viewMode === "table")}
              >
                ▦ Table
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={viewMode === "board"}
                className="ff-task-view-tab"
                data-testid="view-tab-board"
                onClick={() => onViewModeChange("board")}
                style={segmentItemStyle(viewMode === "board")}
              >
                ▤ Board
              </button>
            </span>
          )}

          {(scope !== undefined || buildingName) && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
              {buildingName && (
                <span
                  className="ff-task-building-chip"
                  data-testid="scope-building-chip"
                  title="Jump to the rail's building switcher"
                  style={scopeChipStyle}
                >
                  <span aria-hidden style={{ color: c.muted }}>⌒</span>
                  {buildingName.toUpperCase()}
                  <span aria-hidden style={{ color: c.muted, fontSize: f.xs }}>▾</span>
                </span>
              )}
              {scope !== undefined && onScopeChange && (
                <span role="radiogroup" aria-label="Building scope" style={segmentedPillStyle}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === "building"}
                    className="ff-task-scope-tab"
                    data-testid="scope-tab-building"
                    onClick={() => onScopeChange("building")}
                    style={segmentItemStyle(scope === "building")}
                  >
                    This building
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={scope === "all"}
                    className="ff-task-scope-tab"
                    data-testid="scope-tab-all"
                    onClick={() => onScopeChange("all")}
                    style={segmentItemStyle(scope === "all")}
                  >
                    All buildings
                  </button>
                </span>
              )}
            </span>
          )}

          {savedViews && onSelectView && (
            <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
              <ToolbarButton
                className="ff-task-views-button"
                ariaLabel="Saved views"
                ariaExpanded={viewsOpen}
                buttonRef={setViewsBtn}
                onClick={() => setViewsOpen((o) => !o)}
              >
                {(savedViews.find((v) => v.id === activeViewId)?.label ?? "Views")} ▾
              </ToolbarButton>
              <AnchoredPopover
                anchor={viewsBtn}
                open={viewsOpen}
                onClose={() => setViewsOpen(false)}
                align="start"
                role="menu"
                ariaLabel="Saved views"
                minWidth={170}
              >
                <div
                  className="ff-task-views-menu"
                  style={{
                    background: c.surface,
                    border: `1px solid ${c.border}`,
                    borderRadius: tokens.radius.md,
                    boxShadow: tokens.shadow.raised,
                    padding: 4,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  {savedViews.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={v.id === activeViewId}
                      data-testid={`saved-view-${v.id}`}
                      onClick={() => {
                        onSelectView(v.id === activeViewId ? null : v.id);
                        setViewsOpen(false);
                      }}
                      style={{
                        ...toolbarControlStyle,
                        height: 32,
                        justifyContent: "flex-start",
                        width: "100%",
                        border: "none",
                        background: v.id === activeViewId ? c.focusRingTint : "transparent",
                        color: v.id === activeViewId ? c.focusRingInk : c.text2,
                        fontWeight: v.id === activeViewId ? 700 : 600,
                      }}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>
              </AnchoredPopover>
            </span>
          )}

          {quick && onQuickChange && (
            <span role="group" aria-label="Quick filters" style={{ display: "inline-flex", gap: s.s1 + 2, flex: "0 0 auto" }}>
              <ToolbarChip
                label="My tasks"
                active={!!quick.mine}
                count={quickCounts?.mine}
                testId="quick-mine"
                onPress={() => onQuickChange({ ...quick, mine: !quick.mine })}
              />
              <ToolbarChip
                label="Overdue"
                active={!!quick.overdue}
                count={quickCounts?.overdue}
                testId="quick-overdue"
                onPress={() => onQuickChange({ ...quick, overdue: !quick.overdue })}
              />
            </span>
          )}

          {groupBy !== undefined && onGroupByChange && (
            <ToolbarSelect
              value={groupBy}
              onChange={(v) => onGroupByChange(v as GroupKey)}
              options={GROUP_OPTIONS.map((g) => ({ value: g.id, label: `Group: ${g.label}` }))}
              ariaLabel="Group tasks"
            />
          )}
        </div>
      )}
    </header>
  );
}
