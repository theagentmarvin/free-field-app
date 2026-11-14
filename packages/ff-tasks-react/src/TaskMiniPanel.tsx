import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { deadlineIsOverdue, formatTaskNum, relativeDeadlineLabel } from "./logic";
import { fmtDdMmm } from "./tableColumns";
import { statusAccent, tokens } from "./formStyles";
import { useIsWide } from "./useIsWide";
import {
  filterTasks,
  initialPanelState,
  panelBadgeState,
  scopeTasks,
  PANEL_CHIPS,
  type PanelChip,
  type PanelScope,
  type PanelState,
  type PanelTask,
} from "./panelLogic";

/**
 * <TaskMiniPanel> (Wave 9, spec §A) — the in-context task list over
 * the viewers (2D + 3D), the same component in both hosts.
 *
 * Phone: a collapsed floating pill bottom-left (`≡ {count}`, red dot
 * when any in-scope task is overdue) expands into a bottom sheet over
 * the model/plan. Desktop (`useIsWide`): the panel docks as a slim
 * vertical tab pinned to the viewer's right edge (count + overdue dot)
 * and opens as a right drawer — no pill, no scrim.
 *
 * The panel is PRESENTATIONAL + pure-logic: rows arrive via `tasks`
 * (already merged by the host through the existing task source), and
 * `onLocate` is the only outgoing call — the ancestor wires camera
 * restore / page jump. No firebase, no viewer imports.
 */

export type TaskMiniPanelVariant = "3d" | "2d";

export interface TaskMiniPanelProps {
  /** Merged task rows (cloud + pending via `mergePanelTasks`). */
  tasks: readonly PanelTask[];
  /** Clock for overdue/scope rendering (test-injectable). */
  now?: number;
  /** Current user uid — the `Mine` filter anchor. */
  actorUid?: string | null;
  /** 3D anchor: active storey name for "In view". */
  storeyName?: string | null;
  /** 2D anchor: current PDF page for "In view". */
  pdfPage?: number | null;
  /** Drives the footer hint copy ("model" vs "page"). */
  variant?: TaskMiniPanelVariant;
  /** Tap a row → locate it (restorePinView / goToPage). */
  onLocate: (task: PanelTask) => void;
}

const { color: c, radius: r, fontSize: f } = tokens;

/** Deterministic avatar colour — the mockup uses several; a stable
 *  hash from the assignee id keeps a given person one colour. */
const AVATAR_PALETTE = ["#2f6fe4", "#0e9488", "#e8791f", "#e8a124", "#7a828c"];
function avatarColor(uid: string | null | undefined, name: string | null | undefined): string {
  const seed = uid ?? name ?? "";
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

function assigneeInitial(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "?";
  return n[0].toUpperCase();
}

const DRAWER_WIDTH = 340;
const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function TaskMiniPanel({
  tasks,
  now = Date.now(),
  actorUid = null,
  storeyName = null,
  pdfPage = null,
  variant = "3d",
  onLocate,
}: TaskMiniPanelProps): JSX.Element {
  const isWide = useIsWide();
  const [state, setState] = useState<PanelState>(initialPanelState);
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const scoped = useMemo(
    () => scopeTasks(tasks, { scope: state.scope, storeyName, pdfPage }),
    [tasks, state.scope, storeyName, pdfPage],
  );
  const badge = useMemo(() => panelBadgeState(scoped, now), [scoped, now]);
  const visible = useMemo(
    () => filterTasks(scoped, state.chip, { actorUid, now }),
    [scoped, state.chip, actorUid, now],
  );

  const hint =
    variant === "2d" ? "Tap a row to jump to its pin on this page" : "Tap a row to locate it on the model";

  const setScope = useCallback((scope: PanelScope) => {
    setState((s) => ({ ...s, scope }));
  }, []);
  const setChip = useCallback((chip: PanelChip) => {
    setState((s) => ({ ...s, chip }));
  }, []);
  const handleLocate = useCallback(
    (task: PanelTask) => {
      setState((s) => ({ ...s, selectedId: task.id }));
      onLocate(task);
    },
    [onLocate],
  );

  // Escape closes the sheet; the pill is left untouched (it can be
  // collapsed but has no keyboard "open" gesture of its own here —
  // the pill is a <button>, so Space/Enter toggle it below).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the sheet on open (a11y: role=dialog gets an initial focus).
  useEffect(() => {
    if (!open || isWide) return;
    const el = sheetRef.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, [open, isWide]);

  // Minimal focus trap: keep Tab/Shift+Tab inside the sheet.
  const trapFocus = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const el = sheetRef.current;
    if (!el) return;
    const focusables = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !el.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !el.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  // ── rows ──────────────────────────────────────────────────────────
  const rows = visible.map((t) => {
    const selected = t.id === state.selectedId;
    const rowStyle: CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "11px 10px",
      borderRadius: 10,
      cursor: "pointer",
      border: "none",
      background: selected ? c.focusRingTint : "transparent",
      boxShadow: selected ? "inset 2px 0 0 " + c.focusRing : "none",
      width: "100%",
      textAlign: "left",
      fontFamily: "inherit",
    };
    const label = `${formatTaskNum(t.num)} ${t.title}`;
    return (
      <button
        key={t.id}
        type="button"
        className={`ff-task-mini-row${selected ? " ff-task-mini-row--selected" : ""}`}
        data-testid={`task-mini-row-${t.id}`}
        aria-label={label}
        aria-current={selected ? "true" : undefined}
        onClick={() => handleLocate(t)}
        style={rowStyle}
      >
        <span
          style={{
            width: 8,
            height: 8,
            flex: "0 0 auto",
            borderRadius: "50%",
            background: statusAccent(t.status).bg,
          }}
          aria-hidden
        />
        <span
          style={{
            fontVariantNumeric: "tabular-nums",
            fontWeight: 700,
            fontSize: f.sm,
            color: selected ? c.focusRing : c.text,
            flex: "0 0 auto",
            minWidth: 34,
            letterSpacing: "0.02em",
          }}
        >
          {formatTaskNum(t.num)}
        </span>
        <span
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            fontSize: f.md,
            color: c.text,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {t.title}
        </span>
        {/* Wave 54 — V6 relative deadline (Today · Tomorrow · in 3d ·
            3d late) with --danger on overdue; far dates fall back to
            the boss-approved `dd MMM yyyy`. Replaces the old red
            "Overdue" pill so the mini panel matches the refreshed
            table/board language. */}
        {(() => {
          const hasDeadline = typeof t.deadline === "number" && t.deadline > 0;
          if (!hasDeadline) return null;
          const rel = relativeDeadlineLabel(t.deadline ?? null, now);
          const late = deadlineIsOverdue(t.deadline ?? null, t.status, now);
          return (
            <span
              data-testid={`task-mini-deadline-${t.id}`}
              style={{
                flex: "0 0 auto",
                fontSize: f.xs,
                fontWeight: late ? 700 : 600,
                color: late ? c.danger : c.text2,
                whiteSpace: "nowrap",
              }}
            >
              {rel ? rel.label : fmtDdMmm(t.deadline ?? null)}
            </span>
          );
        })()}
        <span
          style={{
            width: 22,
            height: 22,
            flex: "0 0 auto",
            borderRadius: r.pill,
            color: "#fff",
            fontSize: 11,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            background: avatarColor(t.assigneeUid, t.assigneeName),
          }}
          aria-hidden
        >
          {assigneeInitial(t.assigneeName)}
        </span>
      </button>
    );
  });

  // Scope + filter header + rows — shared by sheet and rail.
  const panelBody = (
    <>
      <div style={headStyle}>
        <span style={titleStyle}>Tasks</span>
        <span style={scopeToggleStyle} role="radiogroup" aria-label="Task scope">
          <button
            type="button"
            aria-pressed={state.scope === "inview"}
            role="radio"
            aria-checked={state.scope === "inview"}
            onClick={() => setScope("inview")}
            style={segStyle(state.scope === "inview")}
          >
            In view
          </button>
          <button
            type="button"
            aria-pressed={state.scope === "all"}
            role="radio"
            aria-checked={state.scope === "all"}
            onClick={() => setScope("all")}
            style={segStyle(state.scope === "all")}
          >
            All
          </button>
        </span>
      </div>
      <div style={filterRowStyle} role="radiogroup" aria-label="Filter tasks">
        {PANEL_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className={chip === state.chip ? "ff-task-mini-chip--active" : ""}
            aria-pressed={chip === state.chip}
            role="radio"
            aria-checked={chip === state.chip}
            onClick={() => setChip(chip)}
            style={chipStyle(chip === state.chip)}
          >
            {chipLabel(chip)}
          </button>
        ))}
        <span style={countBadgeStyle} aria-hidden>
          {visible.length}
        </span>
      </div>
      <div style={rowsStyle}>
        {rows.length === 0 ? (
          <div style={emptyStyle}>No tasks{state.scope === "inview" ? " in view" : ""}.</div>
        ) : (
          rows
        )}
      </div>
      <div style={hintStyle}>{hint}</div>
    </>
  );

  // ── collapsed pill (phone only) ────────────────────────────────────
  const pillLabel =
    state.scope === "inview" ? `Tasks in view: ${badge.count}` : `Tasks: ${badge.count}`;

  if (isWide) {
    // Desktop: slim vertical tab pinned to the viewer's right edge
    // (minimized by default). Tap → right drawer (~340px, full viewer
    // height, its own scroll); the explicit ✕ collapses back to the
    // tab. The count badge + overdue dot live on the tab so the
    // minimized state still signals the in-scope task load.
    return (
      <>
        {!open && (
          <button
            type="button"
            className="ff-task-mini-rail-tab"
            data-testid="task-mini-panel-rail-tab"
            aria-label={pillLabel}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            style={{
              position: "absolute",
              right: 0,
              top: 66,
              zIndex: 16,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              padding: "10px 8px",
              background: c.surface,
              border: `1px solid ${c.borderStrong}`,
              borderRight: "none",
              borderRadius: "10px 0 0 10px",
              boxShadow: "0 4px 14px rgba(16,24,40,0.16)",
              fontWeight: 700,
              fontSize: f.sm,
              color: c.text,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1, color: c.text2 }} aria-hidden>
              ☰
            </span>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{badge.count}</span>
            {badge.overdue && (
              <span
                data-testid="task-mini-panel-overdue-dot"
                aria-label="Overdue tasks in view"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: c.danger,
                  flex: "0 0 auto",
                }}
              />
            )}
          </button>
        )}

        {open && (
          <div
            className="ff-task-mini-rail"
            role="dialog"
            aria-label="Task panel"
            data-testid="task-mini-panel-rail"
            onKeyDown={trapFocus}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: DRAWER_WIDTH,
              background: c.surface,
              border: `1px solid ${c.border}`,
              borderRight: "none",
              borderRadius: "14px 0 0 14px",
              boxShadow: "0 10px 28px rgba(16,24,40,0.18)",
              padding: "12px 13px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 9,
              zIndex: 15,
            }}
          >
            <div
              style={{
                flex: "0 0 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                aria-label="Collapse task panel"
                data-testid="task-mini-panel-collapse"
                onClick={() => setOpen(false)}
                style={{
                  background: "transparent",
                  border: "none",
                  fontSize: 16,
                  lineHeight: 1,
                  color: c.text2,
                  cursor: "pointer",
                  padding: "2px 4px",
                  borderRadius: 4,
                }}
              >
                ✕
              </button>
            </div>
            {panelBody}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <button
        type="button"
        className="ff-task-mini-pill"
        data-testid="task-mini-panel-pill"
        aria-label={pillLabel}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "absolute",
          left: 12,
          bottom: 14,
          zIndex: 25,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "9px 15px",
          background: c.surface,
          border: `1px solid ${c.borderStrong}`,
          borderRadius: r.pill,
          boxShadow: "0 4px 14px rgba(16,24,40,0.18)",
          fontWeight: 700,
          fontSize: f.base,
          color: c.text,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1, color: c.text2 }} aria-hidden>
          ☰
        </span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>{badge.count}</span>
        <span style={{ fontWeight: 600, fontSize: f.sm, color: c.muted }}>tasks</span>
        {badge.overdue && (
          <span
            data-testid="task-mini-panel-overdue-dot"
            aria-label="Overdue tasks in view"
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: c.danger,
              flex: "0 0 auto",
            }}
          />
        )}
      </button>

      {open && (
        <>
          <div
            data-testid="task-mini-panel-scrim"
            aria-hidden
            onClick={() => setOpen(false)}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(16,20,26,0.42)",
              zIndex: 24,
            }}
          />
          <div
            ref={sheetRef}
            className="ff-task-mini-sheet"
            role="dialog"
            aria-label="Task panel"
            data-testid="task-mini-panel-sheet"
            onKeyDown={trapFocus}
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 26,
              background: c.surface,
              borderRadius: "16px 16px 0 0",
              boxShadow: "0 -10px 30px rgba(16,24,40,0.22)",
              padding: "10px 14px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 10,
              maxHeight: "47%",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: 40,
                height: 4,
                borderRadius: r.pill,
                background: c.borderStrong,
                margin: "2px auto 4px",
                flex: "0 0 auto",
              }}
              aria-hidden
            />
            {panelBody}
          </div>
        </>
      )}
    </>
  );
}

// ── helpers / shared styles ─────────────────────────────────────────

function chipLabel(chip: PanelChip): string {
  return chip === "all" ? "All" : chip === "open" ? "Open" : chip === "overdue" ? "Overdue" : "Mine";
}

const headStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flex: "0 0 auto",
};

const titleStyle: CSSProperties = {
  fontWeight: 700,
  fontSize: f.lg,
  letterSpacing: "-0.01em",
  color: c.text,
};

const scopeToggleStyle: CSSProperties = {
  display: "flex",
  marginLeft: "auto",
  background: c.surface2,
  border: `1px solid ${c.border}`,
  borderRadius: r.pill,
  padding: 2,
};

function segStyle(on: boolean): CSSProperties {
  return {
    padding: "4px 11px",
    borderRadius: r.pill,
    fontSize: f.sm,
    fontWeight: 600,
    color: on ? c.onPrimary : c.text2,
    background: on ? c.primary : "transparent",
    border: "none",
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
}

const filterRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  flex: "0 0 auto",
};

function chipStyle(on: boolean): CSSProperties {
  return {
    padding: "5px 12px",
    fontSize: f.sm,
    border: `1px solid ${c.borderStrong}`,
    borderRadius: r.pill,
    background: on ? c.primary : c.surface,
    color: on ? c.onPrimary : c.text2,
    fontWeight: on ? 700 : 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}

const countBadgeStyle: CSSProperties = {
  marginLeft: "auto",
  background: c.focusRing,
  color: "#fff",
  fontSize: 11,
  fontWeight: 700,
  minWidth: 21,
  height: 21,
  padding: "0 7px",
  borderRadius: r.pill,
  display: "grid",
  placeItems: "center",
  fontVariantNumeric: "tabular-nums",
};

const rowsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: "1 1 auto",
  minHeight: 0,
  overflowY: "auto",
};

const emptyStyle: CSSProperties = {
  padding: "16px 4px",
  color: c.muted,
  fontSize: f.md,
  textAlign: "center",
};

const hintStyle: CSSProperties = {
  fontSize: f.xs,
  color: c.muted,
  textAlign: "center",
  flex: "0 0 auto",
  paddingBottom: 2,
};