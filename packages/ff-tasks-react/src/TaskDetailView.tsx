import { useEffect, useRef, useState, type CSSProperties } from "react";

import { EyeClosed } from "iconoir-react";

import {
  isLegal,
  parseDateInput,
  PRIORITY_LABELS,
  priorityOf,
  TASK_PRIORITIES,
  toDateInput,
  validateDescription,
  validateTitle,
  type ChecklistItem,
  type EditableTaskFields,
  type TaskEntryView,
  type TaskPriority,
  type TaskStatus,
  type TaskVerb,
} from "@ff/tasks";
import type { TaskLocation, TaskPhoto } from "@ff/firestore";

import { deadlineSignal, formatTaskNum, isOverdueDeadline, STATUS_LABELS, TYPE_OPTIONS } from "./logic";
import {
  ACTION_LABELS,
  activityCount,
  barVerbsFor,
} from "./detailLogic";
import {
  avatarStyle,
  bottomBarStyle,
  buttonAccentStyle,
  buttonGhostStyle,
  cardStyle,
  cardTightStyle,
  chipOverdueStyle,
  chipTypeStyle,
  iconButtonStyle,
  metaGridStyle,
  projectChipStyle,
  sectionLabelStyle,
  sheetCardStyle,
  sheetFullHeightStyle,
  sheetScrimStyle,
  softStatusDotStyle,
  softStatusStyle,
  statusAccent,
  tokens,
  topBarStyle,
} from "./formStyles";
import { TaskActivityPopup } from "./TaskActivityPopup";
import { TaskFieldRow, editorControlStyle } from "./TaskFieldRow";
import { TaskChecklist } from "./TaskChecklist";
import { TaskConfirmDialog } from "./TaskConfirmDialog";
import { priorityToneStyle } from "./TaskChips";
import { PhotoLightbox } from "./PhotoLightbox";
import { useEscapeClose } from "./useEscapeClose";
import { useIsWide } from "./useIsWide";
import { usePhotoUrl, type PhotoUrlResolver } from "./usePhotoUrl";

/**
 * Task detail sheet (plan §7 screen 3), re-skinned to the validated v2
 * artboards B + C. Status band + task data + location card + read-only
 * fields + attachments grid + verbs-only bottom bar. The timeline now
 * lives in the Activity popup (clock button top-right); comment
 * composer moves there too, on the SAME buildActionPayload→enqueue path.
 *
 * Cross-space locate: the whole location card is the control and fires
 * `onShowIn3D` / `onShowOnPlan` (existing gating: only when pinned in
 * that space AND the host passed the callback). Presentational and
 * prop-fed so the seam test needs no Firebase.
 */

export interface TaskDetailViewProps {
  num: number;
  title: string;
  description: string;
  type?: string;
  status: number | null;
  assigneeName: string | null;
  deadline: number | null;
  location: TaskLocation | null;
  entries: TaskEntryView[];
  photoUrls?: Record<string, string>;
  /** task-level attachments (detail grid) — resolved via photoUrls */
  photos?: TaskPhoto[];
  /** task-data meta from the cloud doc (omitted when absent) */
  createdBy?: string | null;
  createdAt?: number | null;
  updatedBy?: string | null;
  updatedAt?: number | null;
  projectName?: string | null;
  /** UI-refresh v1 §4: building scope of this task — the Building row
   *  in the data card + `Building · Storey` in the location card.
   *  null id = cross-building/legacy → renders "—". */
  buildingId?: string | null;
  buildingName?: string | null;
  /** injection point for deterministic overdue rendering */
  now?: number;
  canAct: boolean;
  onComment: (text: string) => void;
  onTransition: (verb: TaskVerb) => void;
  onRetryEntry: (clientGuid: string) => void;
  onShowIn3D?: (bim: NonNullable<TaskLocation["bim"]>) => void;
  /** Hide the pinned instance(s) (wave 50). Renders the icon control in
   * the location/3D section when the task has a bim pin. */
  onHideInstance?: (bim: NonNullable<TaskLocation["bim"]>) => void;
  onShowOnPlan?: (pdf: NonNullable<TaskLocation["pdf"]>) => void;
  onPrint?: () => void;
  people?: readonly { uid: string; name: string }[];
  onAssign?: (uid: string, name: string) => void;
  onClose: () => void;
  /** Day-3: resolves location.thumb.storagePath → download URL. */
  resolvePhotoUrl?: PhotoUrlResolver;

  // ── w69: inline editing, priority, checklist, watchers, admin delete ──
  /** the task can be edited right now (non-terminal, role allows writes) */
  editable?: boolean;
  /** open the title editor on mount (the E shortcut) */
  startEditing?: boolean;
  assigneeUid?: string | null;
  priority?: string | null;
  checklist?: ChecklistItem[];
  watchers?: string[];
  currentUid?: string | null;
  /** priority / checklist / watchers are available (rules-gated in cloud) */
  extendedFields?: boolean;
  buildingOptions?: readonly { id: string; name: string }[];
  /** one call per saved field: the host diffs, enqueues, logs activity */
  onEditFields?: (next: Partial<EditableTaskFields>) => void;
  onToggleWatch?: () => void;
  /** admin-only hard delete (host decides; confirm lives here) */
  canDelete?: boolean;
  onDelete?: () => void;
}

const { color: c, radius: r, space: s, fontSize: f } = tokens;

function metaLabelStyle(): CSSProperties {
  return {
    fontSize: f.xs,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
    color: c.muted,
    fontWeight: 700,
    marginBottom: 3,
  };
}

function metaValueStyle(): CSSProperties {
  return {
    fontSize: f.md,
    fontWeight: 600,
    display: "flex",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
  };
}

export function TaskDetailView(p: TaskDetailViewProps): JSX.Element {
  const [activityOpen, setActivityOpen] = useState(false);
  useEscapeClose(p.onClose);
  const [zoom, setZoom] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isWide = useIsWide();

  const { status } = p;
  const transitions =
    p.canAct && status !== null
      ? barVerbsFor(status, (v, from) => isLegal(v, from as TaskStatus))
      : [];
  const assignLegal = p.canAct && status !== null && isLegal("assign", status as TaskStatus);

  // Restore keyboard focus to the clock button when the popup closes.
  const clockRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!activityOpen) clockRef.current?.focus();
  }, [activityOpen]);

  const now = p.now ?? Date.now();
  const overdue = isOverdueDeadline(p.deadline, p.status, now);
  const signal = deadlineSignal(p.deadline, p.status, now);
  const editable = !!p.editable && !!p.onEditFields;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const following = !!p.currentUid && (p.watchers ?? []).includes(p.currentUid);
  const accent = status !== null ? statusAccent(status) : { bg: "#7a828c", ink: "#ffffff" };

  const loc = p.location;
  const has3d = !!loc?.bim?.worldPoint;
  const hasBim = !!loc?.bim;
  const hasPlan = !!loc?.pdf;
  const locBadge = has3d ? "3D" : hasPlan ? "2D · plan" : null;
  const locClickable = (has3d && !!p.onShowIn3D) || (hasPlan && !!p.onShowOnPlan);
  const locationThumbUrl = usePhotoUrl(p.resolvePhotoUrl, loc?.thumb?.storagePath ?? null);

  function handleLocate(): void {
    if (loc?.bim?.worldPoint && p.onShowIn3D) p.onShowIn3D(loc.bim);
    else if (loc?.pdf && p.onShowOnPlan) p.onShowOnPlan(loc.pdf);
  }

  const locationCard = (): JSX.Element | null => {
    if (!loc || !locBadge) {
      return (
        <div
          data-testid="detail-location-empty"
          style={{
            display: "flex",
            alignItems: "center",
            gap: s.s3,
            border: `1px dashed ${c.borderStrong}`,
            borderRadius: r.md,
            padding: s.s4,
            background: c.surface2,
          }}
        >
          <span style={{ fontSize: 20, opacity: 0.5 }} aria-hidden>
            📍
          </span>
          <span style={{ fontSize: f.md, color: c.muted }}>
            <b style={{ color: c.text2, fontWeight: 600 }}>Not pinned</b> — pin it from Models or Documents
          </span>
        </div>
      );
    }
    const inner = (
      <>
        <div
          style={{
            position: "relative",
            borderRadius: r.md,
            overflow: "hidden",
            border: `1px solid ${c.border}`,
            height: 140,
            background: "linear-gradient(135deg, #eef1f4, #dde3e9)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 30,
          }}
        >
          {locationThumbUrl ? (
            <img
              data-testid="detail-location-thumb"
              src={locationThumbUrl}
              alt="Location snapshot"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
          ) : (
            <span aria-hidden style={{ opacity: 0.85 }}>
              {has3d ? "🧊" : "🗺️"}
            </span>
          )}
          <span
            style={{
              position: "absolute",
              top: 8,
              left: 8,
              background: "rgba(16,20,26,0.72)",
              color: "#fff",
              fontSize: f.xs,
              fontWeight: 700,
              letterSpacing: "0.05em",
              padding: "3px 8px",
              borderRadius: r.pill,
            }}
          >
            {locBadge}
          </span>
          {locClickable && (
            <span
              aria-hidden
              style={{
                position: "absolute",
                top: 8,
                right: 8,
                width: 24,
                height: 24,
                borderRadius: r.pill,
                background: "rgba(16,20,26,0.55)",
                color: "#fff",
                display: "grid",
                placeItems: "center",
                fontSize: 13,
                lineHeight: 1,
              }}
            >
              ›
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", marginTop: s.s2, fontSize: f.sm, color: c.muted }}>
          <span>
            {(p.buildingName || p.buildingId) ? `${p.buildingName ?? p.buildingId} · ` : ""}
            {loc.storeyName ?? "Site"}
            {has3d ? ` · 3D · ${loc.bim?.elements.length ?? 0} elements` : ""}
            {hasPlan ? ` · plan p.${loc.pdf?.page}` : ""}
          </span>
        </div>
      </>
    );

    if (locClickable) {
      return (
        <button
          type="button"
          data-testid="detail-location-card"
          onClick={handleLocate}
          style={{ display: "block", width: "100%", border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left", font: "inherit", color: "inherit" }}
        >
          {inner}
        </button>
      );
    }
    return <div data-testid="detail-location-card">{inner}</div>;
  };

  const content = (
    <>
      {/* ── top bar ─────────────────────────────────────────────── */}
      <header style={topBarStyle}>
        <button type="button" style={iconButtonStyle} onClick={p.onClose} aria-label="Close">
          ✕
        </button>
        <div style={{ flex: "1 1 auto", textAlign: "center", minWidth: 0 }}>
          <span data-testid="detail-num" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, fontSize: f.base, letterSpacing: "0.02em" }}>
            {p.num > 0
              ? formatTaskNum(p.num)
              : "queued — not committed yet"}
          </span>
        </div>
        <button
          type="button"
          ref={clockRef}
          data-testid="detail-activity-button"
          aria-label="Open activity timeline"
          onClick={() => setActivityOpen(true)}
          style={iconButtonStyle}
        >
          🕐
          <span
            data-testid="detail-activity-count"
            style={{
              position: "absolute",
              top: -4,
              right: -6,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: r.pill,
              background: c.focusRing,
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              display: "grid",
              placeItems: "center",
              lineHeight: 1,
            }}
          >
            {activityCount(p.entries)}
          </span>
        </button>
        {p.extendedFields && p.onToggleWatch && (
          <button
            type="button"
            data-testid="detail-follow"
            aria-pressed={following}
            aria-label={following ? "Unfollow this task" : "Follow this task"}
            title={following ? `Following · ${(p.watchers ?? []).length} watching` : "Follow this task"}
            onClick={p.onToggleWatch}
            disabled={!p.editable}
            style={{ ...iconButtonStyle, color: following ? "#b45309" : c.text2, opacity: p.editable ? 1 : 0.5 }}
          >
            {following ? "★" : "☆"}
          </button>
        )}
        {p.onPrint && (
          <button type="button" data-testid="detail-print" aria-label="Print or save as PDF" title="Print / PDF" onClick={p.onPrint} style={iconButtonStyle}>
            🖨
          </button>
        )}
      </header>

      {/* ── status band (wave 53: soft — dot + label, amber for
          Ongoing via STATUS_HEX) ──────────────────────────────── */}
      {status !== null && (
        <div
          data-testid="detail-status-band"
          style={{
            ...softStatusStyle,
            flex: "0 0 auto",
            display: "flex",
            padding: `9px ${s.s4}px`,
            background: c.surface2,
            borderBottom: `1px solid ${c.border}`,
            fontSize: f.md,
          }}
        >
          <span style={{ ...softStatusDotStyle, background: accent.bg }} aria-hidden />
          {STATUS_LABELS[status] ?? `status ${status}`}
        </div>
      )}

      {/* ── scroll body ─────────────────────────────────────────── */}
      <div ref={scrollRef} style={{ flex: "1 1 auto", overflowY: "auto", padding: s.s3, display: "flex", flexDirection: "column", gap: s.s3, background: c.bg }}>
        {/* task data */}
        <section data-testid="detail-zone-taskdata" style={cardTightStyle}>
          <div style={metaGridStyle}>
            <div>
              <div style={metaLabelStyle()}>Created by</div>
              <div style={metaValueStyle()}>
                {p.createdBy && (
                  <span style={avatarStyle}>{p.createdBy.charAt(0).toUpperCase() || "?"}</span>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.createdBy ?? "—"}
                </span>
              </div>
            </div>
            <div>
              <div style={metaLabelStyle()}>Date created</div>
              <div style={metaValueStyle()}>{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—"}</div>
            </div>
            <div>
              <div style={metaLabelStyle()}>Updated</div>
              <div style={metaValueStyle()}>{p.updatedAt ? new Date(p.updatedAt).toLocaleDateString() : "—"}</div>
            </div>
            <div>
              <div style={metaLabelStyle()}>Updated by</div>
              <div style={metaValueStyle()}>
                {p.updatedBy && (
                  <span style={avatarStyle}>{p.updatedBy.charAt(0).toUpperCase() || "?"}</span>
                )}
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.updatedBy ?? "—"}
                </span>
              </div>
            </div>
            <div>
              <div style={metaLabelStyle()}>Building</div>
              <div style={metaValueStyle()}>
                <span style={projectChipStyle}>{p.buildingName ?? p.buildingId ?? "—"}</span>
              </div>
            </div>
            {p.projectName && (
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={metaLabelStyle()}>Project</div>
                <div style={metaValueStyle()}>
                  <span style={projectChipStyle}>{p.projectName}</span>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* location */}
        <section data-testid="detail-zone-location" style={cardTightStyle}>
          <p style={sectionLabelStyle}>Task location · 2D/3D</p>
          {locationCard()}
          {hasBim && p.onHideInstance && loc?.bim && (
            <button
              type="button"
              data-testid="task-detail-hide-instance"
              aria-label="Hide instance"
              title="Hide instance"
              onClick={() => p.onHideInstance!(loc.bim!)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                marginTop: s.s2,
                padding: "6px 10px",
                border: `1px solid ${c.borderStrong}`,
                borderRadius: r.md,
                background: c.surface,
                color: c.text2,
                fontSize: f.sm,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <EyeClosed width={15} height={15} strokeWidth={1.75} aria-hidden />
              Hide instance
            </button>
          )}
          {editable && (
            <div style={{ marginTop: s.s2 }}>
              <TaskFieldRow<string>
                label="Building"
                testId="building"
                value={p.buildingId ?? ""}
                editable={(p.buildingOptions?.length ?? 0) > 0}
                onSave={(v) => p.onEditFields?.({ buildingId: v || null })}
                display={<span>{p.buildingName ?? p.buildingId ?? "—"}</span>}
                editor={(a) => (
                  <select ref={a.inputRef} data-testid="edit-building" aria-label="Building" value={a.draft} onChange={(e) => a.setDraft(e.target.value)} onKeyDown={a.onKeyDown} style={editorControlStyle}>
                    <option value="">— none —</option>
                    {(p.buildingOptions ?? []).map((b) => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                )}
              />
              <TaskFieldRow<string>
                label="Level"
                testId="level"
                value={loc?.storeyName ?? ""}
                editable
                onSave={(v) => p.onEditFields?.({ storeyName: v.trim() || null })}
                display={<span>{loc?.storeyName || "—"}</span>}
                editor={(a) => (
                  <input ref={a.inputRef} data-testid="edit-level" aria-label="Level" value={a.draft} maxLength={80} onChange={(e) => a.setDraft(e.target.value)} onKeyDown={a.onKeyDown} style={editorControlStyle} />
                )}
              />
              <TaskFieldRow<string>
                label="Note"
                testId="locnote"
                value={loc?.text ?? ""}
                editable
                last
                onSave={(v) => p.onEditFields?.({ locationText: v.trim() || null })}
                display={<span>{loc?.text || "—"}</span>}
                editor={(a) => (
                  <input ref={a.inputRef} data-testid="edit-locnote" aria-label="Location note" value={a.draft} maxLength={200} onChange={(e) => a.setDraft(e.target.value)} onKeyDown={a.onKeyDown} style={editorControlStyle} />
                )}
              />
            </div>
          )}
        </section>

        {/* fields */}
        <section data-testid="detail-zone-fields" style={cardStyle}>
          <p style={sectionLabelStyle}>Task fields</p>
          {!editable && status !== null && status >= 65 && (
            <p data-testid="detail-readonly-note" style={{ margin: `0 0 ${s.s2}px`, fontSize: f.sm, color: c.muted }}>
              Closed tasks are read-only.
            </p>
          )}
          <div>
            <TaskFieldRow<string>
              label="Title"
              testId="title"
              value={p.title}
              editable={editable}
              autoStart={p.startEditing}
              validate={validateTitle}
              onSave={(v) => p.onEditFields?.({ title: v })}
              display={
                <span data-testid="detail-title" style={{ fontSize: f.lg, fontWeight: 700, lineHeight: 1.25, color: c.text }}>
                  {p.title || "(untitled)"}
                </span>
              }
              editor={(a) => (
                <input
                  ref={a.inputRef}
                  data-testid="edit-title"
                  value={a.draft}
                  aria-label="Title"
                  aria-invalid={a.invalid}
                  aria-describedby={a.invalid ? a.errorId : undefined}
                  maxLength={200}
                  onChange={(e) => a.setDraft(e.target.value)}
                  onKeyDown={a.onKeyDown}
                  style={editorControlStyle}
                />
              )}
            />
            {(p.description || editable) && (
              <TaskFieldRow<string>
                label="Description"
                testId="description"
                value={p.description}
                editable={editable}
                multiline
                validate={validateDescription}
                onSave={(v) => p.onEditFields?.({ description: v })}
                display={
                  p.description ? (
                    <span style={{ whiteSpace: "pre-wrap", display: "block" }}>{p.description}</span>
                  ) : (
                    <span style={{ color: c.muted }}>Add a description…</span>
                  )
                }
                editor={(a) => (
                  <textarea
                    ref={a.inputRef}
                    data-testid="edit-description"
                    aria-label="Description"
                    rows={4}
                    value={a.draft}
                    onChange={(e) => a.setDraft(e.target.value)}
                    onKeyDown={a.onKeyDown}
                    style={{ ...editorControlStyle, resize: "vertical" }}
                  />
                )}
              />
            )}
            <TaskFieldRow<string>
              label="Type"
              testId="type"
              value={p.type ?? "task"}
              editable={editable}
              onSave={(v) => p.onEditFields?.({ type: v })}
              display={<span style={chipTypeStyle}>{p.type ? p.type.charAt(0).toUpperCase() + p.type.slice(1) : "Task"}</span>}
              editor={(a) => {
                const opts = TYPE_OPTIONS.includes(a.draft) || !a.draft ? TYPE_OPTIONS : [...TYPE_OPTIONS, a.draft];
                return (
                  <select
                    ref={a.inputRef}
                    data-testid="edit-type"
                    aria-label="Type"
                    value={a.draft}
                    onChange={(e) => a.setDraft(e.target.value)}
                    onKeyDown={a.onKeyDown}
                    style={editorControlStyle}
                  >
                    {!a.draft && <option value="">—</option>}
                    {opts.map((t) => (
                      <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                    ))}
                  </select>
                );
              }}
            />
            {p.extendedFields && (
              <TaskFieldRow<TaskPriority>
                label="Priority"
                testId="priority"
                value={priorityOf(p.priority)}
                editable={editable}
                onSave={(v) => p.onEditFields?.({ priority: v })}
                display={
                  <span data-testid="detail-priority" style={priorityToneStyle(priorityOf(p.priority))}>
                    {PRIORITY_LABELS[priorityOf(p.priority)]}
                  </span>
                }
                editor={(a) => (
                  <select
                    ref={a.inputRef}
                    data-testid="edit-priority"
                    aria-label="Priority"
                    value={a.draft}
                    onChange={(e) => a.setDraft(e.target.value as TaskPriority)}
                    onKeyDown={a.onKeyDown}
                    style={editorControlStyle}
                  >
                    {TASK_PRIORITIES.map((t) => (
                      <option key={t} value={t}>{PRIORITY_LABELS[t]}</option>
                    ))}
                  </select>
                )}
              />
            )}
            <TaskFieldRow<string>
              label="Assignee"
              testId="assignee"
              value={p.assigneeUid ?? ""}
              editable={editable && (p.people?.length ?? 0) > 0}
              onSave={(uid) => {
                const person = (p.people ?? []).find((x) => x.uid === uid);
                p.onEditFields?.({ assigneeUid: uid || null, assigneeName: person?.name ?? null });
              }}
              display={
                p.assigneeName ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ ...avatarStyle, width: 22, height: 22, fontSize: 11 }}>{p.assigneeName.charAt(0).toUpperCase()}</span>
                    {p.assigneeName}
                  </span>
                ) : (
                  <span style={{ color: c.muted }}>—</span>
                )
              }
              editor={(a) => (
                <select
                  ref={a.inputRef}
                  data-testid="edit-assignee"
                  aria-label="Assignee"
                  value={a.draft}
                  onChange={(e) => a.setDraft(e.target.value)}
                  onKeyDown={a.onKeyDown}
                  style={editorControlStyle}
                >
                  <option value="">Unassigned</option>
                  {(p.people ?? []).map((x) => (
                    <option key={x.uid} value={x.uid}>{x.name}</option>
                  ))}
                </select>
              )}
            />
            <TaskFieldRow<string>
              label="Deadline"
              testId="deadline"
              value={toDateInput(p.deadline)}
              editable={editable}
              last
              validate={(v) => (v && parseDateInput(v) === null ? "Enter a valid date." : null)}
              onSave={(v) => p.onEditFields?.({ deadline: v ? parseDateInput(v) : null })}
              display={
                <span
                  style={{
                    color: overdue ? c.danger : signal === "soon" ? "#7a4b00" : c.text,
                    fontWeight: overdue || signal === "soon" ? 600 : 400,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {p.deadline !== null && p.deadline > 0 ? new Date(p.deadline).toLocaleDateString() : "—"}
                  {overdue && <span style={chipOverdueStyle}>Overdue</span>}
                  {!overdue && signal === "soon" && (
                    <span data-testid="detail-due-soon" style={{ ...chipOverdueStyle, background: "#fdf1d8", color: "#7a4b00" }}>Due soon</span>
                  )}
                </span>
              }
              editor={(a) => (
                <div style={{ display: "flex", gap: s.s2 }}>
                  <input
                    ref={a.inputRef}
                    type="date"
                    data-testid="edit-deadline"
                    aria-label="Deadline"
                    value={a.draft}
                    onChange={(e) => a.setDraft(e.target.value)}
                    onKeyDown={a.onKeyDown}
                    style={editorControlStyle}
                  />
                  <button
                    type="button"
                    data-testid="edit-deadline-clear"
                    onClick={() => a.setDraft("")}
                    style={{ border: `1px solid ${c.borderStrong}`, background: c.surface, borderRadius: r.md, padding: "0 10px", cursor: "pointer", fontFamily: "inherit", fontSize: f.sm, fontWeight: 600 }}
                  >
                    No deadline
                  </button>
                </div>
              )}
            />
          </div>
        </section>

        {/* checklist */}
        {p.extendedFields && (
          <section data-testid="detail-zone-checklist" style={cardTightStyle}>
            <p style={sectionLabelStyle}>Checklist</p>
            <TaskChecklist
              items={p.checklist ?? []}
              editable={editable}
              onChange={(next) => p.onEditFields?.({ checklist: next })}
            />
          </section>
        )}

        {/* attachments */}
        {(p.photos?.length ?? 0) > 0 && (
          <section data-testid="detail-zone-attachments" style={cardTightStyle}>
            <p style={sectionLabelStyle}>Attachments · {p.photos!.length}/10</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: s.s2 }}>
              {p.photos!.map((ph, i) => {
                const url = p.photoUrls?.[ph.storagePath];
                return url ? (
                  <button
                    key={`${ph.storagePath}-${i}`}
                    type="button"
                    data-testid="detail-photo-thumb"
                    aria-label="Open photo"
                    onClick={() => setZoom(url)}
                    style={{ padding: 0, border: `1px solid ${c.border}`, borderRadius: r.md, overflow: "hidden", aspectRatio: "1 / 1", cursor: "zoom-in", background: c.surface2 }}
                  >
                    <img src={url} alt="task photo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  </button>
                ) : (
                  <div
                    key={`${ph.storagePath}-${i}`}
                    style={{ aspectRatio: "1 / 1", borderRadius: r.md, border: `1px solid ${c.border}`, background: c.surface2, display: "grid", placeItems: "center", fontSize: 18, color: c.muted }}
                  >
                    📷
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* ── verbs-only bottom bar ───────────────────────────────── */}
      {(transitions.length > 0 || assignLegal) && (
        <footer data-testid="detail-actions" style={bottomBarStyle}>
          <div style={{ display: "flex", gap: s.s2, flexWrap: "wrap" }}>
            {transitions.map((v) => (
              <button
                key={v}
                type="button"
                data-testid={`detail-action-${v}`}
                onClick={() => p.onTransition(v)}
                style={v === "complete" ? { ...buttonAccentStyle, flex: "1 1 0", minHeight: 42, fontSize: f.md } : { ...buttonGhostStyle, flex: "1 1 0", minHeight: 42, fontSize: f.md }}
              >
                {ACTION_LABELS[v] ?? v}
              </button>
            ))}
            {assignLegal && (p.people?.length ?? 0) > 0 && p.onAssign && (
              <div style={{ width: "100%", display: "flex", gap: s.s2, alignItems: "center", fontSize: f.md, color: c.text2 }}>
                <span aria-hidden>👤</span>
                <select
                  data-testid="detail-assign"
                  value=""
                  onChange={(ev) => {
                    const picked = (p.people ?? []).find((x) => x.uid === ev.target.value);
                    if (picked) {
                      p.onAssign!(picked.uid, picked.name);
                    }
                  }}
                  style={{ flex: 1, padding: "6px 8px", border: `1px solid ${c.borderStrong}`, borderRadius: r.md, fontSize: f.md, background: c.surface }}
                >
                  <option value="" disabled>
                    {p.assigneeName ? `Re-assign (now ${p.assigneeName})…` : "Assign to…"}
                  </option>
                  {(p.people ?? []).map((x) => (
                    <option key={x.uid} value={x.uid}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </footer>
      )}

      {p.canDelete && p.onDelete && (
        <div style={{ flex: "0 0 auto", padding: `${s.s2}px ${s.s4}px`, borderTop: `1px solid ${c.border}`, background: c.surface, display: "flex", justifyContent: "space-between", alignItems: "center", gap: s.s3 }}>
          <span style={{ fontSize: f.xs, color: c.muted }}>Admin</span>
          <button
            type="button"
            data-testid="detail-delete"
            onClick={() => setConfirmDelete(true)}
            style={{ border: `1px solid ${c.danger}`, color: c.danger, background: c.surface, borderRadius: r.md, padding: "6px 12px", fontWeight: 700, fontSize: f.sm, cursor: "pointer", fontFamily: "inherit" }}
          >
            Delete task…
          </button>
        </div>
      )}
      {confirmDelete && (
        <TaskConfirmDialog
          title={`Delete ${p.num > 0 ? formatTaskNum(p.num) : "this task"} permanently?`}
          body="The task and its activity history are removed for everyone. This can’t be undone — use Discontinue to close a task and keep its record."
          confirmLabel="Delete permanently"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            p.onDelete?.();
          }}
        />
      )}

      {/* activity popup */}
      {activityOpen && (
        <TaskActivityPopup
          num={p.num}
          entries={p.entries}
          photoUrls={p.photoUrls}
          onRetryEntry={p.onRetryEntry}
          onComment={p.onComment}
          people={p.people}
          currentUid={p.currentUid}
          onClose={() => setActivityOpen(false)}
        />
      )}

      {zoom && <PhotoLightbox src={zoom} srcs={(p.photos ?? []).map((ph) => p.photoUrls?.[ph.storagePath]).filter((u): u is string => !!u)} onClose={() => setZoom(null)} testId="photo-lightbox" ariaLabel="Photo viewer" />}
    </>
  );

  if (!isWide) {
    return (
      <aside role="dialog" aria-label="Task detail" className="ff-task-detail" style={sheetFullHeightStyle}>
        {content}
      </aside>
    );
  }

  return (
    <div
      data-testid="task-sheet-scrim"
      className="ff-task-detail-scrim"
      style={sheetScrimStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) p.onClose();
      }}
    >
      <aside role="dialog" aria-label="Task detail" className="ff-task-detail" style={sheetCardStyle}>
        {content}
      </aside>
    </div>
  );
}