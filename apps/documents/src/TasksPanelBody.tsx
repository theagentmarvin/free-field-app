// apps/documents/src/TasksPanelBody.tsx
//
// The "Tasks" BODY of the Documents floating panel slot: the list of tasks
// placed on the open sheet (scope "In view" = the current page, or "All" of
// the building). The scope / chip logic is the shared pure module of
// `@ff/tasks-react` (panelLogic), the rows come from the same task source as
// the plan's markers. Tapping a row jumps the sheet to that task's page,
// where the plan's marker layer already draws its pin.

import { useMemo, useState, type CSSProperties, type RefObject } from "react";

import {
  deadlineIsOverdue,
  filterTasks,
  formatTaskNum,
  panelBadgeState,
  relativeDeadlineLabel,
  scopeTasks,
  statusAccent,
  tokens,
  usePanelActorUid,
  PANEL_CHIPS,
  type PanelChip,
  type PanelScope,
  type PanelTask,
} from "@ff/tasks-react";
import type { PdfOverlayHandle } from "@ff/viewer-react";

const { color: c, radius: r, fontSize: f } = tokens;

export interface TasksPanelBodyProps {
  /** Every task of the active building. */
  tasks: readonly PanelTask[];
  /** The page the open sheet shows ("In view" anchor). */
  currentPage: number;
  /** Handle of the mounted PDF viewer (page jump). */
  overlayRef: RefObject<PdfOverlayHandle> | null;
}

export default function TasksPanelBody({
  tasks,
  currentPage,
  overlayRef,
}: TasksPanelBodyProps): JSX.Element {
  const actorUid = usePanelActorUid();
  const [scope, setScope] = useState<PanelScope>("inview");
  const [chip, setChip] = useState<PanelChip>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const scoped = useMemo(
    () => scopeTasks(tasks, { scope, pdfPage: currentPage }),
    [tasks, scope, currentPage],
  );
  const now = Date.now();
  const badge = useMemo(() => panelBadgeState(scoped, now), [scoped, now]);
  const visible = useMemo(
    () => filterTasks(scoped, chip, { actorUid, now }),
    [scoped, chip, actorUid, now],
  );

  function handleLocate(task: PanelTask): void {
    setSelectedId(task.id);
    const page = task.location?.pdf?.page;
    if (typeof page === "number" && page >= 1) overlayRef?.current?.goToPage(page);
  }

  return (
    <div data-testid="documents-tasks-panel-body" aria-label="Tasks">
      <div style={headStyle}>
        <span style={scopeToggleStyle} role="radiogroup" aria-label="Task scope">
          <button
            type="button"
            role="radio"
            aria-checked={scope === "inview"}
            aria-pressed={scope === "inview"}
            onClick={() => setScope("inview")}
            style={segStyle(scope === "inview")}
          >
            In view
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={scope === "all"}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
            style={segStyle(scope === "all")}
          >
            All
          </button>
        </span>
        <span style={countBadgeStyle} aria-hidden data-testid="documents-tasks-panel-count">
          {badge.count}
        </span>
      </div>

      <div style={filterRowStyle} role="radiogroup" aria-label="Filter tasks">
        {PANEL_CHIPS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={chip === k}
            aria-pressed={chip === k}
            onClick={() => setChip(k)}
            style={chipStyle(chip === k)}
          >
            {chipLabel(k)}
          </button>
        ))}
        {badge.overdue && (
          <span style={overdueStyle} data-testid="documents-tasks-panel-overdue">
            Overdue
          </span>
        )}
      </div>

      <div style={rowsStyle}>
        {visible.length === 0 ? (
          <div style={emptyStyle} data-testid="documents-tasks-panel-empty">
            No tasks{scope === "inview" ? " on this page" : ""}.
          </div>
        ) : (
          visible.map((t) => {
            const selected = t.id === selectedId;
            const hasDeadline = typeof t.deadline === "number" && t.deadline > 0;
            const rel = hasDeadline ? relativeDeadlineLabel(t.deadline ?? null, now) : null;
            const late = hasDeadline && deadlineIsOverdue(t.deadline ?? null, t.status, now);
            return (
              <button
                key={t.id}
                type="button"
                aria-label={`${formatTaskNum(t.num)} ${t.title}`}
                aria-current={selected ? "true" : undefined}
                onClick={() => handleLocate(t)}
                style={rowStyle(selected)}
                data-testid={`documents-tasks-row-${t.id}`}
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
                {rel && (
                  <span
                    style={{
                      flex: "0 0 auto",
                      fontSize: f.xs,
                      fontWeight: late ? 700 : 600,
                      color: late ? c.danger : c.text2,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {rel.label}
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

function chipLabel(chip: PanelChip): string {
  return chip === "all" ? "All" : chip === "open" ? "Open" : chip === "overdue" ? "Overdue" : "Mine";
}

const headStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0 8px" };

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

const rowsStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

function rowStyle(selected: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "8px 9px",
    borderRadius: 8,
    cursor: "pointer",
    border: "none",
    background: selected ? c.focusRingTint : "transparent",
    boxShadow: selected ? `inset 2px 0 0 ${c.focusRing}` : "none",
    width: "100%",
    textAlign: "left",
    fontFamily: "inherit",
  };
}

const emptyStyle: CSSProperties = {
  padding: "16px 4px",
  color: c.muted,
  fontSize: f.md,
  textAlign: "center",
};
