import { useEffect, useRef, useState, type CSSProperties } from "react";

import { useEscapeClose } from "./useEscapeClose";
import { useExtendedFieldsEnabled } from "./capabilities";
import { SheetChips, SheetPicker } from "./SheetAttachments";
import { useSheetCatalog } from "./sheetCatalog";
import {
  isLinkviewLocation,
  sha256Hex,
  clearDraft,
  saveDraft,
  type DraftTable,
  type OutboxEngine,
} from "@ff/tasks";
import type { TaskLocation } from "@ff/firestore";

import {
  buildComposeEnqueues,
  emptyCompose,
  quickDeadline,
  toDraftFields,
  type ComposeFields,
  type ComposeLocationThumb,
  type ComposePhoto,
} from "./composeModel";
import { registerBlob, releaseBlob } from "./useTaskEngine";
import { useOnlineStatus } from "./useOnlineStatus";
import { resolveCreateBuildingId, useProjectBuildings, useTaskBuildingIndex, type TaskBuildingIndex } from "./taskBuilding";
import { useIsWide } from "./useIsWide";
import { TYPE_OPTIONS, isCustomType } from "./logic";
import {
  avatarStyle,
  bottomBarStyle,
  buttonPrimaryStyle,
  cardStyle,
  cardTightStyle,
  chipAssignMeStyle,
  chipOptionSelectedStyle,
  chipOptionStyle,
  chipRowStyle,
  chipTypeStyle,
  controlStyle,
  fieldLabelStyle,
  fieldStyle,
  iconButtonStyle,
  metaGridStyle,
  offlineStripStyle,
  projectChipStyle,
  quickChipsStyle,
  sectionLabelStyle,
  sheetCardStyle,
  sheetFullHeightStyle,
  sheetScrimStyle,
  tokens,
  topBarStyle,
} from "./formStyles";

/**
 * Compose sheet (plan §7 screen 2, re-skinned to the validated v2
 * artboard A). Text/assignee/deadline/photos — the §11 cut list stays
 * cut. Submit enqueues create(+assign) into the outbox and clears the
 * draft; the optimistic overlay does the rest.
 *
 * Autosnapshot: while dirty, every 15 s the fields land in `drafts`
 * under the sheet's taskId (draft id == taskId, §2.4).
 */

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = /^image\/(jpeg|png|webp)$/;

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export interface TaskComposeSheetProps {
  projectId: string;
  taskId: string;
  actor: { uid: string; name: string };
  members: { uid: string; name: string }[];
  engine: OutboxEngine;
  draftTable: DraftTable;
  /** set by the 3D/2D pin flow (chunk 3); null = unlocated */
  location?: TaskLocation | null;
  /** Day-3: the snapshot thumb captured at the tap (preview + outbox ref). */
  locationThumb?: ComposeLocationThumb | null;
  /** LinkView dual location: the plan snapshot captured with the 3D one. */
  locationThumb2d?: ComposeLocationThumb | null;
  initial?: Partial<ComposeFields>;
  /** resolved project display name; task-data card omits the row when absent */
  projectName?: string | null;
  /** UI-refresh v1 §2: the rail's active building — inherited by the new
   *  task, one-tap overridable. null/undefined = no row wiring. */
  buildingId?: string | null;
  /** the project's buildings for the override control; ≤4 renders the
   *  same tinted-chip row as Type, otherwise a native picker (spec §5). */
  buildings?: readonly { id: string; name: string }[];
  /** model/PDF → building index used to stamp a building from the pinned
   *  location when no context building exists (defaults to the live index). */
  buildingIndex?: TaskBuildingIndex;
  /** show "Attach from project" (rules-gated field; defaults to the session capability) */
  extendedFields?: boolean;
  onDone: () => void;
  onClose: () => void;
}

function toLocalDateInput(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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

export function TaskComposeSheet({
  projectId,
  taskId,
  actor,
  members,
  engine,
  draftTable,
  location = null,
  locationThumb: locationThumbProp = null,
  locationThumb2d: locationThumb2dProp = null,
  initial,
  projectName = null,
  buildingId = null,
  buildings: buildingsProp,
  buildingIndex: buildingIndexProp,
  extendedFields: extendedFieldsProp,
  onDone,
  onClose,
}: TaskComposeSheetProps): JSX.Element {
  const capsExtended = useExtendedFieldsEnabled();
  const extendedFields = extendedFieldsProp ?? capsExtended;
  const sheetCatalog = useSheetCatalog(projectId);
  const [pickerOpen, setPickerOpen] = useState(false);
  const liveBuildingIndex = useTaskBuildingIndex();
  const buildingIndex = buildingIndexProp ?? liveBuildingIndex;
  // Viewer-hosted creators (Models, LinkView, Documents) pass no list: name
  // the stamped building from the project's local rows.
  const liveBuildings = useProjectBuildings(projectId);
  const buildings = buildingsProp ?? (liveBuildings.length > 0 ? liveBuildings : undefined);
  const [fields, setFields] = useState<ComposeFields>({
    ...emptyCompose(),
    location,
    locationThumb: locationThumbProp,
    locationThumb2d: locationThumb2dProp,
    ...initial,
    // inherit the creation context's building unless the draft/initial
    // chose one (a restored draft with no building must NOT wipe it)
    buildingId: initial?.buildingId ?? buildingId,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [titleFocused, setTitleFocused] = useState(false);
  const online = useOnlineStatus();
  const isWide = useIsWide();
  useEscapeClose(onClose);
  const createdAt = useRef(Date.now()).current;

  const dirty = useRef(false);
  const latest = useRef(fields);
  latest.current = fields;

  // Day-3: release the snapshot blob when the sheet closes WITHOUT a
  // submit (the executor still needs it after a successful submit).
  const submittedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Deferred so React StrictMode's simulated unmount/remount (dev) does
      // not revoke the snapshot's object URL while the sheet is still alive.
      const thumbs = [latest.current.locationThumb, latest.current.locationThumb2d];
      setTimeout(() => {
        if (mountedRef.current || submittedRef.current) return;
        for (const thumb of thumbs) {
          if (!thumb?.blobKey) continue;
          releaseBlob(thumb.blobKey);
          if (thumb.previewUrl && typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(thumb.previewUrl);
          }
        }
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (!dirty.current) return;
    const t = setInterval(() => {
      if (!dirty.current) return;
      void saveDraft(draftTable, taskId, projectId, toDraftFields(latest.current, projectId, taskId)).then(
        () => setLastSavedAt(Date.now())
      );
    }, 15_000);
    return () => clearInterval(t);
  }, [draftTable, taskId, projectId, fields]);

  const patch = (over: Partial<ComposeFields>): void => {
    dirty.current = true;
    setFields((f) => ({ ...f, ...over }));
  };

  async function attachFiles(files: FileList | null): Promise<void> {
    const next: ComposePhoto[] = [...fields.photos];
    for (const file of Array.from(files ?? [])) {
      if (!IMAGE_TYPES.test(file.type) || file.size > MAX_PHOTO_BYTES) continue;
      const sha256 = await sha256Hex(await file.arrayBuffer());
      const dup = next.some((p) => p.sha256 === sha256); // dedupe by bytes
      if (dup) continue;
      const blobKey = crypto.randomUUID();
      registerBlob(blobKey, file);
      next.push({ blobKey, sha256, size: file.size, mime: file.type, previewUrl: URL.createObjectURL(file) });
    }
    patch({ photos: next });
  }

  function dropPhoto(blobKey: string): void {
    const removed = fields.photos.find((p) => p.blobKey === blobKey);
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    releaseBlob(blobKey);
    patch({ photos: fields.photos.filter((p) => p.blobKey !== blobKey) });
  }

  async function submit(): Promise<void> {
    if (!fields.title.trim() || busy) return;
    setBusy(true);
    setError(null);
    submittedRef.current = true;
    try {
      for (const payload of buildComposeEnqueues(
        {
          ...fields,
          buildingId: resolveCreateBuildingId(
            { explicit: fields.buildingId, context: buildingId, location: fields.location },
            buildingIndex,
          ),
        },
        { projectId, taskId, actor, at: Date.now() })) {
        await engine.enqueue(payload);
      }
      await clearDraft(draftTable, taskId);
      dirty.current = false;
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const assignToMe = (): void => {
    patch({ assigneeUid: actor.uid, assigneeName: actor.name });
  };

  const clearLocation = (): void => {
    for (const thumb of [fields.locationThumb, fields.locationThumb2d]) {
      if (!thumb?.blobKey) continue;
      releaseBlob(thumb.blobKey);
      if (thumb.previewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(thumb.previewUrl);
      }
    }
    patch({ location: null, locationThumb: null, locationThumb2d: null });
  };

  const loc = fields.location;
  const has3d = !!loc?.bim?.worldPoint;
  const hasPlan = !!loc?.pdf;
  const locBadge = isLinkviewLocation(loc) ? "2D + 3D" : has3d ? "3D" : hasPlan ? "2D · plan" : null;
  const locContext = loc
    ? `${loc.storeyName ?? "Site"}${has3d ? ` · 3D · ${loc.bim?.elements.length ?? 0} elements` : ""}${
        hasPlan ? ` · plan p.${loc.pdf?.page}` : ""
      }`
    : null;

  const selectedType = fields.type;
  const customType = isCustomType(selectedType);

  const titleLabel = metaLabelStyle();
  const titleValue = metaValueStyle();

  const content = (
    <>
      {/* ── zone 1 · top bar ─────────────────────────────────────── */}
      <header data-testid="compose-zone-topbar" style={topBarStyle}>
        <button type="button" style={iconButtonStyle} onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div style={{ flex: "1 1 auto", textAlign: "center", minWidth: 0 }}>
          <span data-testid="compose-topbar-title" style={{ fontWeight: 700, fontSize: f.base }}>
            New task{" "}
            <span style={{ fontWeight: 600, color: c.muted, fontSize: f.xs }}>· draft — T# on send</span>
          </span>
        </div>
        <span style={{ width: 40 }} aria-hidden />
      </header>

      {/* ── offline strip (variant, zone 1b) ─────────────────────── */}
      {!online && (
        <div data-testid="compose-offline-strip" role="status" style={offlineStripStyle}>
          ⚠️ Offline — changes queue automatically
        </div>
      )}

      {/* ── scroll body ─────────────────────────────────────────── */}
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: s.s3, display: "flex", flexDirection: "column", gap: s.s3, background: c.bg }}>
        {/* ── zone 2 · task data (read-only receipt) ─────────────── */}
        <section data-testid="compose-zone-taskdata" style={cardTightStyle}>
          <div style={metaGridStyle}>
            <div>
              <div style={titleLabel}>Created by</div>
              <div style={titleValue}>
                <span style={avatarStyle}>{actor.name.charAt(0).toUpperCase() || "?"}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{actor.name}</span>
                <span style={{ fontWeight: 400, color: c.muted }}>(you)</span>
              </div>
            </div>
            <div>
              <div style={titleLabel}>Date created</div>
              <div style={titleValue}>{new Date(createdAt).toLocaleDateString()}</div>
            </div>
            {projectName && (
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={titleLabel}>Project</div>
                <div style={titleValue}>
                  <span style={projectChipStyle}>{projectName}</span>
                </div>
              </div>
            )}
            {/* UI-refresh v1 §4 — Building row: inherits the rail value,
                one-tap overridable; the choice persists into the draft
                (toDraftFields carries buildingId). Omitted when the
                host passes no building wiring (standalone/demo). */}
            {(buildings !== undefined || buildingId) && (
              <div style={{ gridColumn: "1 / -1" }}>
                <div style={titleLabel}>Building</div>
                {(buildings?.length ?? 0) > 4 ? (
                  <select
                    data-testid="compose-building-select"
                    aria-label="Task building"
                    style={controlStyle}
                    value={fields.buildingId ?? ""}
                    onChange={(e) => patch({ buildingId: e.target.value || null })}
                  >
                    <option value="">Cross-building (—)</option>
                    {(buildings ?? []).map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div style={chipRowStyle}>
                    <button
                      type="button"
                      data-testid="compose-building-none"
                      aria-pressed={fields.buildingId == null}
                      onClick={() => patch({ buildingId: null })}
                      style={fields.buildingId == null ? chipOptionSelectedStyle : chipOptionStyle}
                    >
                      Cross-building
                    </button>
                    {(buildings ?? []).map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        data-testid={`compose-building-${b.id}`}
                        aria-pressed={fields.buildingId === b.id}
                        onClick={() => patch({ buildingId: b.id })}
                        style={fields.buildingId === b.id ? chipOptionSelectedStyle : chipOptionStyle}
                      >
                        {b.name}
                      </button>
                    ))}
                    {buildingId && fields.buildingId == null && (buildings?.length ?? 0) === 0 && (
                      <span style={chipTypeStyle}>{buildingId}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── zone 3 · location (card IS the control) ────────────── */}
        <section data-testid="compose-zone-location" style={cardTightStyle}>
          <p style={sectionLabelStyle}>Task location · 2D/3D</p>
          {loc && locBadge ? (
            <div>
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
                {fields.locationThumb2d?.previewUrl && fields.locationThumb?.previewUrl ? (
                  <div
                    data-testid="compose-location-thumb-dual"
                    style={{ position: "absolute", inset: 0, display: "flex", gap: 2 }}
                  >
                    <img
                      data-testid="compose-location-thumb-2d"
                      src={fields.locationThumb2d.previewUrl}
                      alt="Plan snapshot"
                      style={{ width: "50%", height: "100%", objectFit: "cover" }}
                    />
                    <img
                      data-testid="compose-location-thumb-3d"
                      src={fields.locationThumb.previewUrl}
                      alt="3D snapshot"
                      style={{ width: "50%", height: "100%", objectFit: "cover" }}
                    />
                  </div>
                ) : fields.locationThumb?.previewUrl ? (
                  <img
                    data-testid="compose-location-thumb"
                    src={fields.locationThumb.previewUrl}
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
                  <span aria-hidden style={{ opacity: 0.85 }}>{has3d ? "🧊" : "🗺️"}</span>
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
                <button
                  type="button"
                  data-testid="compose-location-clear"
                  aria-label="Clear location"
                  onClick={clearLocation}
                  style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 24,
                    height: 24,
                    borderRadius: r.pill,
                    border: "none",
                    background: "rgba(16,20,26,0.55)",
                    color: "#fff",
                    fontSize: 13,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "grid",
                    placeItems: "center",
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              </div>
              {locContext && (
                <div style={{ display: "flex", alignItems: "center", marginTop: s.s2, fontSize: f.sm, color: c.muted }}>
                  <span>{locContext}</span>
                </div>
              )}
            </div>
          ) : (
            <div
              data-testid="compose-location-empty"
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
          )}
        </section>

        {/* ── zone 4 · task fields ───────────────────────────────── */}
        <section data-testid="compose-zone-fields" style={cardStyle}>
          <p style={sectionLabelStyle}>Task fields</p>

          <div style={fieldStyle}>
            <label htmlFor="ff-task-title" style={fieldLabelStyle}>
              Title <span style={{ color: c.danger, fontWeight: 700 }}>*</span>
              <span data-testid="compose-title-count" style={{ color: c.muted, fontWeight: 400, fontSize: f.xs, marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                {fields.title.length}/200
              </span>
            </label>
            <input
              id="ff-task-title"
              data-testid="compose-title"
              style={{
                ...controlStyle,
                borderColor: titleFocused ? c.focusRing : c.borderStrong,
                boxShadow: titleFocused ? `0 0 0 3px ${c.focusRingLine}` : undefined,
              }}
              onFocus={() => setTitleFocused(true)}
              onBlur={() => setTitleFocused(false)}
              value={fields.title}
              onChange={(e) => patch({ title: e.target.value })}
              maxLength={200}
              placeholder="e.g. Re-install smoke detector at stair core"
            />
          </div>

          <div style={fieldStyle}>
            <label htmlFor="ff-task-desc" style={fieldLabelStyle}>
              Description
            </label>
            <textarea
              id="ff-task-desc"
              data-testid="compose-description"
              style={{ ...controlStyle, alignItems: "flex-start", minHeight: 84, resize: "none", padding: "10px 12px" }}
              value={fields.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="Add context and acceptance criteria…"
            />
          </div>

          <div style={fieldStyle}>
            <label style={fieldLabelStyle}>Type</label>
            <div role="radiogroup" aria-label="Task type" style={chipRowStyle}>
              {TYPE_OPTIONS.map((opt) => {
                const selected = selectedType === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    data-testid={`compose-type-${opt}`}
                    onClick={() => patch({ type: opt })}
                    style={selected ? chipOptionSelectedStyle : chipOptionStyle}
                  >
                    {opt}
                  </button>
                );
              })}
              {customType && (
                <button
                  type="button"
                  role="radio"
                  aria-checked
                  data-testid="compose-type-custom"
                  onClick={() => patch({ type: selectedType })}
                  style={chipOptionSelectedStyle}
                >
                  {selectedType}
                </button>
              )}
            </div>
          </div>

          <div style={fieldStyle}>
            <label htmlFor="ff-task-assignee" style={fieldLabelStyle}>
              Assignee
            </label>
            <div style={{ display: "flex", gap: s.s2, alignItems: "center" }}>
              <select
                id="ff-task-assignee"
                data-testid="compose-assignee"
                style={{ ...controlStyle, flex: "1 1 auto" }}
                value={fields.assigneeUid ?? ""}
                onChange={(e) => {
                  const m = members.find((x) => x.uid === e.target.value) ?? null;
                  patch({ assigneeUid: m?.uid ?? null, assigneeName: m?.name ?? null });
                }}
              >
                <option value="">Unassigned</option>
                {members.map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button type="button" data-testid="compose-assign-me" style={chipAssignMeStyle} onClick={assignToMe}>
                Assign to me
              </button>
            </div>
          </div>

          <div style={{ ...fieldStyle, marginBottom: 0 }}>
            <label htmlFor="ff-task-deadline" style={fieldLabelStyle}>
              Deadline
            </label>
            <div style={quickChipsStyle}>
              <button type="button" data-testid="compose-deadline-today" style={chipOptionStyle} onClick={() => patch({ deadline: quickDeadline(Date.now(), "today") })}>
                Today
              </button>
              <button type="button" data-testid="compose-deadline-tomorrow" style={chipOptionStyle} onClick={() => patch({ deadline: quickDeadline(Date.now(), "tomorrow") })}>
                Tomorrow
              </button>
              <button type="button" data-testid="compose-deadline-week" style={chipOptionStyle} onClick={() => patch({ deadline: quickDeadline(Date.now(), "week") })}>
                +1 week
              </button>
            </div>
            <input
              id="ff-task-deadline"
              data-testid="compose-deadline"
              type="date"
              style={controlStyle}
              value={toLocalDateInput(fields.deadline)}
              onChange={(e) => patch({ deadline: e.target.value ? new Date(`${e.target.value}T12:00:00`).getTime() : null })}
            />
          </div>
        </section>

        {/* ── zone 5 · attachments ───────────────────────────────── */}
        <section data-testid="compose-zone-attachments" style={cardTightStyle}>
          <p style={sectionLabelStyle}>
            Attachments · {fields.photos.length}/10
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: s.s2 }}>
            {fields.photos.map((p) => (
              <div key={p.blobKey} style={{ position: "relative", aspectRatio: "1 / 1", borderRadius: r.md, overflow: "hidden", border: `1px solid ${c.border}` }}>
                {p.previewUrl ? (
                  <img src={p.previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <div style={{ width: "100%", height: "100%", background: c.surface2 }} />
                )}
                <button
                  type="button"
                  aria-label="Remove photo"
                  data-testid="compose-photo-remove"
                  onClick={() => dropPhoto(p.blobKey)}
                  style={{
                    position: "absolute",
                    top: 5,
                    right: 5,
                    width: 22,
                    height: 22,
                    borderRadius: r.pill,
                    border: "none",
                    background: "rgba(16,20,26,0.66)",
                    color: "#fff",
                    fontSize: 11,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "grid",
                    placeItems: "center",
                    padding: 0,
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <label
              data-testid="compose-add-photo"
              style={{
                aspectRatio: "1 / 1",
                borderRadius: r.md,
                border: `1.5px dashed ${c.borderStrong}`,
                background: c.surface2,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 3,
                color: c.muted,
                fontSize: f.xs,
                cursor: "pointer",
              }}
            >
              <span style={{ fontSize: 20, lineHeight: 1, color: c.text2 }} aria-hidden>
                +
              </span>
              Add
              <input
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                style={{ display: "none" }}
                onChange={(e) => void attachFiles(e.target.files)}
              />
            </label>
          </div>
          {extendedFields && (
            <div data-testid="compose-sheets" style={{ marginTop: s.s3, display: "flex", flexDirection: "column", gap: s.s2 }}>
              <SheetChips
                refs={fields.sheetRefs ?? []}
                catalog={sheetCatalog}
                projectId={projectId}
                onRemove={(ref) =>
                  patch({
                    sheetRefs: (fields.sheetRefs ?? []).filter(
                      (x) => !(x.pdfFileId === ref.pdfFileId && x.pdfVersionId === ref.pdfVersionId && x.page === ref.page),
                    ),
                  })
                }
              />
              <button
                type="button"
                data-testid="compose-attach-from-project"
                onClick={() => setPickerOpen(true)}
                style={{ alignSelf: "flex-start", height: 36, padding: "0 14px", borderRadius: r.md, border: `1px solid ${c.borderStrong}`, background: c.surface, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, fontSize: f.md, color: c.text }}
              >
                📄 Attach from project
              </button>
            </div>
          )}
          {pickerOpen && (
            <SheetPicker
              projectId={projectId}
              buildingId={fields.buildingId ?? buildingId ?? null}
              selected={fields.sheetRefs ?? []}
              onChange={(next) => patch({ sheetRefs: next })}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </section>
      </div>

      {/* ── sticky bottom ────────────────────────────────────────── */}
      <footer data-testid="compose-zone-bottom" style={bottomBarStyle}>
        {error && (
          <p role="alert" style={{ color: c.danger, margin: 0, fontSize: f.sm }}>
            {error}
          </p>
        )}
        <button
          type="button"
          data-testid="compose-send"
          disabled={!fields.title.trim() || busy}
          onClick={() => void submit()}
          style={{
            ...buttonPrimaryStyle,
            width: "100%",
            opacity: fields.title.trim() && !busy ? 1 : 0.5,
            cursor: fields.title.trim() && !busy ? "pointer" : "not-allowed",
          }}
        >
          {busy ? "Queuing…" : "Send task"}
        </button>
        {!fields.title.trim() && (
          <div data-testid="compose-send-hint" style={{ fontSize: f.xs, color: c.muted, textAlign: "center" }}>
            Add a title first
          </div>
        )}
        <div style={{ fontSize: f.xs, color: c.muted, textAlign: "center" }}>
          {lastSavedAt
            ? `Draft autosaved · ${new Date(lastSavedAt).toLocaleString()}`
            : "Draft autosaves automatically"}
        </div>
      </footer>
    </>
  );

  if (!isWide) {
    return (
      <aside role="dialog" aria-label="New task" className="ff-task-compose" style={sheetFullHeightStyle}>
        {content}
      </aside>
    );
  }

  return (
    <div
      data-testid="task-sheet-scrim"
      className="ff-task-compose-scrim"
      style={sheetScrimStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside role="dialog" aria-label="New task" className="ff-task-compose" style={sheetCardStyle}>
        {content}
      </aside>
    </div>
  );
}