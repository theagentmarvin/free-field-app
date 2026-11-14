import type { CSSProperties } from "react";

import {
  formatTaskNum,
  initialsOf,
  isOverdue,
  relativeDeadlineLabel,
  STATUS_LABELS,
} from "./logic";
import { avatarAccent, avatarMiniStyle, softStatusStyle, statusAccent, tokens } from "./formStyles";
import { fmtDdMmm, type TaskTableRow } from "./tableColumns";
import { usePhotoUrl, type PhotoUrlResolver } from "./usePhotoUrl";
import { LocationThumb } from "./LocationThumb";

/**
 * Presentational task list (plan §7 screen 1's row anatomy: status dot +
 * num + title + assignee + deadline badge).
 *
 * VDC 2026-11-02 (Wave 1A): a row with photo evidence now shows a 24px
 * thumb between the T-number and the title. The host opts IN by
 * passing `resolvePhotoUrl` (Storage path → download URL) — the panel
 * itself stays Firebase-free: the resolution is a plain promise, and
 * the shared cache in `usePhotoUrl.ts` keeps N rows on one photo down
 * to ONE lookup. No resolver (demo mode, or a host without Storage)
 * → rows render exactly as before.
 */

export interface TasksListPanelProps {
  rows: TaskTableRow[];
  now: number;
  onOpen?: (task: TaskTableRow) => void;
  onRetry?: (task: TaskTableRow) => void;
  emptyLabel?: string;
  /** host-supplied Storage resolver; absent → no thumbs at all */
  resolvePhotoUrl?: PhotoUrlResolver;
}

const dotStyle: CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  flex: "0 0 auto",
  display: "inline-block",
};

const thumbStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  objectFit: "cover",
  flex: "0 0 auto",
  background: "#f1f3f4",
  border: "1px solid #e4e6e7",
};

/** One row's first-photo thumb. A failed/unresolved photo renders
 *  NOTHING — no broken image, no error badge, no layout shift. */
function TaskThumb({
  path,
  resolve,
  label,
}: {
  path: string | undefined;
  resolve: PhotoUrlResolver | undefined;
  label: string;
}): JSX.Element | null {
  const url = usePhotoUrl(resolve, path);
  if (!url) return null;
  return (
    <img
      className="ff-task-thumb"
      data-testid="ff-task-thumb"
      src={url}
      alt={label}
      title={label}
      width={24}
      height={24}
      style={thumbStyle}
    />
  );
}

/** V3 soft dot — accent palette (formStyles tokens, no new hexes). */
function statusDotColor(status: number): string {
  return statusAccent(status).bg;
}

export function TasksListPanel({
  rows,
  now,
  onOpen,
  onRetry,
  emptyLabel = "No tasks yet.",
  resolvePhotoUrl,
}: TasksListPanelProps): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="ff-tasks-empty" style={{ padding: 24, color: "#777" }}>
        {emptyLabel}
      </div>
    );
  }
  return (
    <ul
      className="ff-tasks-list"
      role="list"
      style={{ listStyle: "none", margin: 0, padding: 0 }}
    >
      {rows.map((t) => {
        const overdue = isOverdue(t, now);
        const rel = relativeDeadlineLabel(t.deadline ?? null, now);
        const deadlineText = rel ? rel.label : fmtDdMmm(t.deadline ?? null);
        const building = t.buildingId == null ? null : t.buildingName || t.buildingId;
        const metaBits = [building, t.storeyName].filter(Boolean) as string[];
        return (
        <li
          key={t.id}
          className={[
            "ff-task-row",
            t.pending ? "ff-task-row--pending" : "",
            t.failed ? "ff-task-row--failed" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          style={{
            display: "flex",
            flexWrap: "wrap", // meta line wraps instead of overflowing at 360px
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: `1px solid ${tokens.color.border}`,
            cursor: onOpen ? "pointer" : "default",
            background: tokens.color.surface,
            opacity: t.pending && !t.failed ? 0.55 : 1, // striped/half-alpha stand-in until CSS pass
          }}
          onClick={() => onOpen?.(t)}
          aria-label={`${formatTaskNum(t.num)} ${t.title}`}
        >
          {/* V3 — soft status: quiet dot + muted label */}
          <span style={{ ...softStatusStyle, color: tokens.color.text2 }}>
            <span
              style={{ ...dotStyle, background: statusDotColor(t.status) }}
              title={STATUS_LABELS[t.status] ?? String(t.status)}
              aria-label={STATUS_LABELS[t.status] ?? String(t.status)}
            />
            {STATUS_LABELS[t.status] ?? String(t.status)}
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums", color: tokens.color.muted }}>
            {formatTaskNum(t.num)}
          </span>
          <TaskThumb
            path={t.photos?.[0]?.storagePath}
            resolve={resolvePhotoUrl}
            label={`Photo for ${formatTaskNum(t.num)}`}
          />
          <LocationThumb
            path={t.locationThumbPath}
            resolve={resolvePhotoUrl}
            label={`Location snapshot for ${formatTaskNum(t.num)}`}
          />
          <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t.title}
            {metaBits.length > 0 && (
              <span
                className="ff-task-row-meta"
                data-testid="ff-task-row-meta"
                style={{ display: "block", fontSize: tokens.fontSize.xs, color: tokens.color.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {metaBits.join(" \u00b7 ")}
              </span>
            )}
          </span>
          {t.assigneeName && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: tokens.color.text2, fontSize: tokens.fontSize.md, minWidth: 0 }}>
              <span aria-hidden style={{ ...avatarMiniStyle, background: avatarAccent(t.assigneeName) }}>
                {initialsOf(t.assigneeName)}
              </span>
            </span>
          )}
          {typeof t.deadline === "number" && t.deadline > 0 && (
            <span
              className="ff-task-deadline"
              style={{
                fontSize: tokens.fontSize.sm,
                color: overdue ? tokens.color.danger : tokens.color.muted,
                fontWeight: overdue ? 700 : 500,
                whiteSpace: "nowrap",
              }}
            >
              {overdue ? `\ud83d\udd51 ${deadlineText}` : deadlineText}
            </span>
          )}
          {t.failed && (
            <button
              type="button"
              className="ff-task-retry"
              aria-label="Retry failed action"
              style={{ border: `1px solid ${tokens.color.danger}`, color: tokens.color.danger, background: "white", borderRadius: 6, padding: "2px 8px" }}
              onClick={(e) => {
                e.stopPropagation();
                onRetry?.(t);
              }}
            >
              ⚠ retry
            </button>
          )}
        </li>
        );
      })}
    </ul>
  );
}
