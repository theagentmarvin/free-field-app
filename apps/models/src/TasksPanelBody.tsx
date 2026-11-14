// apps/models/src/TasksPanelBody.tsx
//
// Wave 35 (toolbar-nav redesign) — the "Tasks" BODY of the one
// floating nav panel.
//
// It shows the SAME rows as the floating <TaskMiniPanel>: both read
// `usePanelTasks()` (the existing task source + outbox overlay), so
// the panel and the mini panel can never disagree. The scope / chip
// logic is the shared pure module (`@ff/tasks-react`'s panelLogic),
// not a re-implementation.
//
// Scope (spec §10 open question, proposal): level-filtered when a
// level is open, the building's model-pinned tasks otherwise — that
// is exactly what the mini panel's "In view" scope does.

import { useMemo, useState, type CSSProperties } from "react";

import {
  filterTasks,
  formatTaskNum,
  isPanelOverdue,
  panelBadgeState,
  restorePinView,
  scopeTasks,
  statusAccent,
  tokens,
  usePanelActorUid,
  usePanelTasks,
  PANEL_CHIPS,
  type PanelChip,
  type PanelScope,
  type PanelTask,
} from "@ff/tasks-react";

import type { IfcViewerHandle } from "@ff/viewer-react";
import type { RefObject } from "react";

const { color: c, radius: r, fontSize: f } = tokens;

export interface TasksPanelBodyProps {
  /** Handle to the 3D viewer (used to locate a task). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** The open level (scopes the "In view" filter). */
  storeyName?: string | null;
  /** Open the task detail sheet for a task id (wave 50 — the same
   * open path the 3D pin tap uses). Additive to the camera fly-to. */
  onOpenTask?: (taskId: string) => void;
}

export default function TasksPanelBody({
  viewerRef,
  storeyName = null,
  onOpenTask,
}: TasksPanelBodyProps): JSX.Element {
  const tasks = usePanelTasks();
  const actorUid = usePanelActorUid();

  const [scope, setScope] = useState<PanelScope>("inview");
  const [chip, setChip] = useState<PanelChip>("all");

  const scoped = useMemo(
    () => scopeTasks(tasks, { scope, storeyName }),
    [tasks, scope, storeyName],
  );
  const now = Date.now();
  const badge = useMemo(() => panelBadgeState(scoped, now), [scoped, now]);
  const visible = useMemo(
    () => filterTasks(scoped, chip, { actorUid, now }),
    [scoped, chip, actorUid, now],
  );

  function handleLocate(task: PanelTask): void {
    const h = viewerRef.current;
    const bim = task.location?.bim;
    if (h) {
      restorePinView(h, {
        taskId: task.id,
        num: task.num,
        title: task.title,
        status: task.status,
        pending: false,
        worldPoint: (bim?.worldPoint ?? [0, 0, 0]) as [number, number, number],
        cameraPose: bim?.cameraPose ?? null,
        elements: bim?.elements ?? [],
      });
    }
    // Wave 50 — navigate AND open the detail sheet. The open is
    // additive to the camera fly-to; it is the same open path the 3D
    // pin tap uses (`onOpenTask={(pin) => setDetailTaskId(pin.taskId)}`).
    onOpenTask?.(task.id);
  }

  return (
    <div data-testid="tasks-panel-body" aria-label="Tasks">
      <div style={headStyle}>
        <span style={scopeToggleStyle} role="radiogroup" aria-label="Task scope">
          <button
            type="button"
            aria-pressed={scope === "inview"}
            role="radio"
            aria-checked={scope === "inview"}
            onClick={() => setScope("inview")}
            style={segStyle(scope === "inview")}
          >
            In view
          </button>
          <button
            type="button"
            aria-pressed={scope === "all"}
            role="radio"
            aria-checked={scope === "all"}
            onClick={() => setScope("all")}
            style={segStyle(scope === "all")}
          >
            All
          </button>
        </span>
        <span style={countBadgeStyle} aria-hidden>
          {badge.count}
        </span>
      </div>

      <div style={filterRowStyle} role="radiogroup" aria-label="Filter tasks">
        {PANEL_CHIPS.map((c0) => (
          <button
            key={c0}
            type="button"
            aria-pressed={chip === c0}
            role="radio"
            aria-checked={chip === c0}
            onClick={() => setChip(c0)}
            style={chipStyle(chip === c0)}
          >
            {chipLabel(c0)}
          </button>
        ))}
        {badge.overdue && (
          <span style={overdueStyle} data-testid="tasks-panel-overdue-dot">
            Overdue
          </span>
        )}
      </div>

      <div style={rowsStyle}>
        {visible.length === 0 ? (
          <div style={emptyStyle}>
            No tasks{scope === "inview" ? " in view" : ""}.
          </div>
        ) : (
          visible.map((t) => {
            const overdue = isPanelOverdue(t, now);
            return (
              <button
                key={t.id}
                type="button"
                aria-label={`${formatTaskNum(t.num)} ${t.title}`}
                onClick={() => handleLocate(t)}
                style={rowStyle}
                data-testid={`tasks-panel-row-${t.id}`}
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
                    color: c.text,
                    flex: "0 0 auto",
                    minWidth: 34,
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
                {overdue && (
                  <span
                    style={{
                      flex: "0 0 auto",
                      fontSize: 10,
                      fontWeight: 700,
                      padding: "1px 7px",
                      borderRadius: r.pill,
                      background: c.danger,
                      color: "#fff",
                    }}
                  >
                    Overdue
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

function chipLabel(chip: PanelChip): string {
  return chip === "all"
    ? "All"
    : chip === "open"
      ? "Open"
      : chip === "overdue"
        ? "Overdue"
        : "Mine";
}

// ── styles ────────────────────────────────────────────────────────────

const headStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "2px 0 8px",
};

const scopeToggleStyle: CSSProperties = {
  display: "flex",
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

const filterRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  paddingBottom: 8,
};

function chipStyle(on: boolean): CSSProperties {
  return {
    padding: "4px 10px",
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

const overdueStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 10,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: r.pill,
  background: "rgba(214,69,69,0.12)",
  color: c.danger,
};

const rowsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "8px 9px",
  borderRadius: 8,
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "left",
  fontFamily: "inherit",
};

const emptyStyle: CSSProperties = {
  padding: "16px 4px",
  color: c.muted,
  fontSize: f.md,
  textAlign: "center",
};
