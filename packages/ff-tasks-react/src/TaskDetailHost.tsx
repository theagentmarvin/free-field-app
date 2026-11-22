import { useSheetCatalog } from "./sheetCatalog";
import { useOpenTaskLocation } from "./taskTarget";
import { effectiveTaskBuildingId, useTaskBuildingIndex, type BuildingScopedTask } from "./taskBuilding";
import { useEffect, useMemo, useRef, useState } from "react";


import { requireProjectId, useProjectId } from "@ff/auth";
import type { Task, TaskEntry, TaskLocation, TaskStatus } from "@ff/firestore";
import {
  buildActionPayload,
  buildEditPatch,
  diffTaskFields,
  displayStatus,
  isEditableStatus,
  isLinkviewLocation,
  mergeTaskEntries,
  mergeTaskViews,
  normalizeChecklist,
  normalizeWatchers,
  normalizeSheetRefs,
  verbForEdit,
  type EditableTaskFields,
  type TaskVerb,
  type TaskView,
} from "@ff/tasks";

import { TaskDetailView } from "./TaskDetailView";
import { latestEntryActor } from "./detailLogic";
import { buildTaskPrintHtml, openPrintView, type PrintTaskView } from "./printDocument";
import { useTaskEngine } from "./useTaskEngine";
import { useTaskCapabilities } from "./capabilities";
import { useTaskPeople } from "./useTaskPeople";
import { useTasksFirestore, useTasksSource } from "./tasksSource";
import { useTaskPhotoResolver } from "./photoResolver";
import type { PhotoUrlResolver } from "./usePhotoUrl";
import { useOutboxRows } from "./useOutboxRows";

/**
 * All the Firebase/Dexie wiring for the detail sheet, so every host
 * (TasksApp list, models Viewer, documents dock) mounts one line.
 * Cloud-first like the rest: the live queries come through the single
 * `useTasksSource()` switch (Firestore or the Dexie-backed demo source),
 * the outbox overlay adds ⋯/⚠ queued rows (§4/D5), and every action goes
 * out as a verb through buildActionPayload → engine.enqueue — never a
 * direct status edit (§0 idea 1).
 *
 * `statusFrom` uses the OPTIMISTIC display status, so two rapid
 * clicks (complete → approve while the first row is still queued)
 * still produce a legal chain — the engine commits in order.
 */

export interface TaskDetailHostProps {
  taskId: string;
  onClose: () => void;
  /** passed by hosts that own a 3D viewer (models view) */
  onShowIn3D?: (bim: NonNullable<TaskLocation["bim"]>) => void;
  /** passed by hosts that own a 3D viewer — hide the pinned instance(s)
   * (wave 50). Renders a small icon control in the location/3D section. */
  onHideInstance?: (bim: NonNullable<TaskLocation["bim"]>) => void;
  /** passed by hosts that own the PDF overlay (documents dock) */
  onShowOnPlan?: (pdf: NonNullable<TaskLocation["pdf"]>) => void;
  /** resolved project display name; task-data chip omitted when absent */
  projectName?: string | null;
  /** UI-refresh v1: host's building list (id → name) for the detail's
   *  Building row + `Building · Storey` line. */
  buildings?: readonly { id: string; name: string }[];
  /** Day-3: resolves location.thumb.storagePath for the detail card. */
  resolvePhotoUrl?: PhotoUrlResolver;
  /** w69: open the title editor immediately (the E shortcut) */
  startEditing?: boolean;
}

interface QueuedCreate {
  title: string;
  description: string;
  location: TaskLocation | null;
  buildingId?: string | null;
  sheetRefs?: unknown;
}

export function TaskDetailHost({
  taskId,
  onClose,
  onShowIn3D,
  onShowOnPlan,
  onHideInstance,
  projectName = null,
  buildings,
  resolvePhotoUrl,
  startEditing = false,
}: TaskDetailHostProps): JSX.Element {
  const caps = useTaskCapabilities();
  const engine = useTaskEngine();
  const source = useTasksSource();
  const db = useTasksFirestore();
  const projectId = useProjectId();
  const { actor, members, ensureMembers } = useTaskPeople(db, projectId);

  // VDC Bug 4: the assign picker needs the roster; one lazy fetch per
  // sheet (the hook caches it for the session / returns the demo roster).
  useEffect(() => {
    if (engine) void ensureMembers();
  }, [engine, ensureMembers]);

  const [task, setTask] = useState<Task | null>(null);
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  useEffect(() => {
    if (!projectId) {
      setTask(null);
      setEntries([]);
      return;
    }
    let unsubTask = () => {};
    let unsubEntries = () => {};
    try {
      unsubTask = source.watchTask(projectId, taskId, setTask);
      unsubEntries = source.watchTaskEntries(projectId, taskId, setEntries);
    } catch {
      /* offline — queued rows still render from the outbox */
    }
    return () => {
      unsubTask();
      unsubEntries();
    };
  }, [source, projectId, taskId]);

  const rows = useOutboxRows(projectId);
  const views = useMemo(
    () => mergeTaskEntries(entries, rows, taskId, source.overlaySending),
    [entries, rows, taskId, source.overlaySending],
  );
  const status = displayStatus(task?.status ?? null, views);

  // Optimistic doc: queued edit patches (title, deadline, assignee,
  // priority, checklist, watchers, location…) overlay the committed doc
  // immediately — the same merge the list rows use — so an inline save
  // shows at once and settles when the commit lands.
  const buildingIndex = useTaskBuildingIndex();
  const liveTask = useMemo<(Task & Partial<TaskView>) | null>(() => {
    if (!task) return null;
    const mine = rows.filter((r) => (r.payload as { taskId?: string } | undefined)?.taskId === taskId);
    if (mine.length === 0) return task;
    const merged = mergeTaskViews([task as unknown as TaskView], mine, { overlaySending: source.overlaySending });
    const v = merged.find((m) => m.id === taskId);
    return v ? ({ ...task, ...(v as unknown as Partial<Task>) } as Task & Partial<TaskView>) : task;
  }, [task, rows, taskId, source.overlaySending]);

  // Meta: "Updated" / "Updated by" come from the LATEST timeline entry
  // (the Host already holds the merged entries — no extra fetch); absent
  // when there are no entries so the UI omits the lines, never fakes.
  const updatedAt = views.length > 0 ? views[views.length - 1].at : null;
  const updatedBy = latestEntryActor(views);

  // VDC Bug 3: photo evidence must be VIEWABLE, not counted. Resolve
  // each storagePath to a display URL once per path (requestedRef
  // suppresses retry storms on failed paths, e.g. offline); unresolved
  // ones keep the 📷 chip fallback. Demo resolves through the local
  // store's data URL; cloud through Firebase Storage.
  const resolvePhoto = useTaskPhotoResolver();
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const requestedPhotos = useRef(new Set<string>());
  // Photos of a just-created task aren't resolvable until their upload lands:
  // a miss is retried a few times with backoff instead of staying a 📷 chip.
  const photoAttempts = useRef(new Map<string, number>());
  const [photoRetryTick, setPhotoRetryTick] = useState(0);
  useEffect(() => {
    if (!resolvePhoto) return;
    const missing = new Set<string>();
    for (const e of views)
      for (const ph of e.photos ?? [])
        if (ph.storagePath && !requestedPhotos.current.has(ph.storagePath)) {
          requestedPhotos.current.add(ph.storagePath);
          missing.add(ph.storagePath);
        }
    // task-level attachments ALSO resolve through the same map so the
    // detail grid can render tappable thumbnails (VDC Bug 3).
    for (const ph of task?.photos ?? [])
      if (ph.storagePath && !requestedPhotos.current.has(ph.storagePath)) {
        requestedPhotos.current.add(ph.storagePath);
        missing.add(ph.storagePath);
      }
    if (missing.size === 0) return;
    let dead = false;
    void Promise.allSettled(
      [...missing].map((p) => resolvePhoto(p).then((url) => [p, url] as const))
    ).then((rs) => {
      if (dead) return;
      setPhotoUrls((prev) => {
        const next = { ...prev };
        for (const r of rs) if (r.status === "fulfilled" && r.value[1]) next[r.value[0]] = r.value[1];
        return next;
      });
      let retry = false;
      for (const r of rs) {
        const path = r.status === "fulfilled" ? r.value[0] : null;
        const ok = r.status === "fulfilled" && !!r.value[1];
        if (!path || ok) continue;
        const n = (photoAttempts.current.get(path) ?? 0) + 1;
        photoAttempts.current.set(path, n);
        if (n <= 4) {
          requestedPhotos.current.delete(path);
          retry = true;
        }
      }
      if (retry) {
        const n = Math.max(...[...photoAttempts.current.values()]);
        retryTimer = setTimeout(() => setPhotoRetryTick((t) => t + 1), 1000 * Math.min(n, 4));
      }
    });
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      dead = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [views, task, resolvePhoto, photoRetryTick]);

  // queued create with no cloud doc yet — header falls back to the
  // payload so the sheet opens instantly on submit.
  const queuedCreate = useMemo<QueuedCreate | null>(() => {
    if (task) return null;
    for (const r of rows) {
      const isPending =
        r.state === "added" ||
        r.state === "failed" ||
        (source.overlaySending && r.state === "sending");
      if (!isPending) continue;
      const p = r.payload as unknown as {
        verb?: string;
        taskId?: string;
        title?: string;
        createDoc?: { description?: string; location?: TaskLocation | null };
      };
      if (p.taskId === taskId && p.verb === "create") {
        return {
          title: p.title ?? "",
          description: p.createDoc?.description ?? "",
          location: p.createDoc?.location ?? null,
          buildingId: (p.createDoc as { buildingId?: string | null } | undefined)?.buildingId ?? null,
          sheetRefs: (p.createDoc as { sheetRefs?: unknown } | undefined)?.sheetRefs,
        };
      }
    }
    return null;
  }, [task, rows, taskId]);

  function act(verb: TaskVerb, text = ""): void {
    if (!engine || status === null) return;
    const pid = requireProjectId(projectId); // write: never without a project
    try {
      void engine.enqueue(
        buildActionPayload({
          verb,
          projectId: pid,
          taskId,
          statusFrom: status as TaskStatus,
          actor,
          title: task?.title ?? "",
          text,
        })
      );
    } catch {
      /* illegal verb for the state — the action bar already filtered it */
    }
  }

  // Post-creation (re-)assign: same verb + patch shape the compose
  // sheet's auto-flip uses, so rules and the executor path are already
  // proven; only the entry point is new.
  function assignTo(uid: string, name: string): void {
    if (!engine || status === null) return;
    const pid = requireProjectId(projectId); // write: never without a project
    try {
      void engine.enqueue(
        buildActionPayload({
          verb: "assign",
          projectId: pid,
          taskId,
          statusFrom: status as TaskStatus,
          actor,
          title: task?.title ?? "",
          patch: { assigneeUid: uid, assigneeName: name },
        })
      );
    } catch {
      /* illegal from this state — the picker already gates on isLegal */
    }
  }

  // The stamped building, else the one the task is pinned in (old tasks).
  const effectiveBuildingId = effectiveTaskBuildingId(
    {
      buildingId: liveTask?.buildingId ?? queuedCreate?.buildingId ?? null,
      location: (liveTask?.location ?? queuedCreate?.location ?? null) as BuildingScopedTask["location"],
    },
    buildingIndex,
  );

  const sheetCatalog = useSheetCatalog(projectId ?? null);
  const openLocation = useOpenTaskLocation();
  const taskLoc = (liveTask?.location ?? queuedCreate?.location ?? null) as BuildingScopedTask["location"] & { bim?: { worldPoint?: unknown } | null };
  const hasBimLoc = !!taskLoc?.bim?.worldPoint;
  const hasPdfLoc = !!taskLoc?.pdf;

  const buildingNameOf = (id: string | null): string | null =>
    id ? (buildings?.find((b) => b.id === id)?.name ?? null) : null;

  /**
   * Inline edit → ONE outbox action: the diff is computed against the
   * OPTIMISTIC doc (so rapid edits chain), an assignee-only change keeps
   * the assign semantics, and the entry text reads "changed deadline
   * from A to B" — the activity-log line for every change.
   */
  function editFields(next: Partial<EditableTaskFields>): void {
    if (!engine || !liveTask || status === null) return;
    if (!caps.extendedFields) {
      delete next.priority;
      delete next.checklist;
      delete next.watchers;
      delete next.sheetRefs;
    }
    const pid = requireProjectId(projectId); // write: never without a project
    const loc = liveTask.location as TaskLocation | null;
    const before: Partial<EditableTaskFields> = {
      title: liveTask.title,
      description: liveTask.description ?? "",
      type: liveTask.type ?? "task",
      deadline: liveTask.deadline ?? null,
      assigneeUid: liveTask.assigneeUid ?? null,
      assigneeName: liveTask.assigneeName ?? null,
      buildingId: liveTask.buildingId ?? null,
      storeyName: loc?.storeyName ?? null,
      locationText: loc?.text ?? null,
      priority: liveTask.priority as EditableTaskFields["priority"] | undefined,
      checklist: normalizeChecklist(liveTask.checklist),
      watchers: normalizeWatchers(liveTask.watchers),
      sheetRefs: normalizeSheetRefs(liveTask.sheetRefs),
    };
    const changes = diffTaskFields(before, next, { buildingName: buildingNameOf });
    if (changes.length === 0) return;
    const verb = verbForEdit(status, changes);
    if (!verb) return;
    const patch = buildEditPatch(next, changes, loc as Parameters<typeof buildEditPatch>[2]);
    try {
      void engine.enqueue(
        buildActionPayload({
          verb,
          projectId: pid,
          taskId,
          statusFrom: status as TaskStatus,
          actor,
          title: (patch.title as string | undefined) ?? liveTask.title,
          text: changes.map((c) => c.text).join("; "),
          patch,
        })
      );
    } catch {
      /* terminal state — the editors were already hidden */
    }
  }

  function toggleWatch(): void {
    if (!liveTask || !actor.uid) return;
    const cur = normalizeWatchers(liveTask.watchers);
    const next = cur.includes(actor.uid) ? cur.filter((u) => u !== actor.uid) : [...cur, actor.uid];
    editFields({ watchers: next });
  }

  async function deleteTask(): Promise<void> {
    if (!caps.hardDelete || !projectId) return;
    try {
      await source.deleteTask(requireProjectId(projectId), taskId);
      onClose();
    } catch {
      /* permission denied until the rules change ships — the sheet stays */
    }
  }

  // Print / Save-as-PDF: the browser IS the PDF engine (zero deps,
  // offline-safe). Photo storage paths resolve to display URLs first,
  // best-effort — unresolved ones fall back to the 📷 count chip.
  async function handlePrint(): Promise<void> {
    let photoUrls: Record<string, string> | undefined;
    let locationThumbUrl: string | null = null;
    let locationThumb2dUrl: string | null = null;
    try {
      const paths = new Set<string>();
      for (const e of views) for (const p of e.photos ?? []) if (p.storagePath) paths.add(p.storagePath);
      const thumbPath = (task?.location ?? queuedCreate?.location)?.thumb?.storagePath ?? null;
      const thumb2dPath = (task?.location ?? queuedCreate?.location)?.thumb2d?.storagePath ?? null;
      if ((paths.size > 0 || thumbPath || thumb2dPath) && resolvePhoto) {
        if (paths.size > 0) {
          const resolved = await Promise.allSettled(
            [...paths].map((p) => resolvePhoto(p).then((url) => [p, url] as const))
          );
          photoUrls = {};
          for (const r of resolved) if (r.status === "fulfilled" && r.value[1]) photoUrls[r.value[0]] = r.value[1];
        }
        if (thumbPath) {
          try {
            locationThumbUrl = await resolvePhoto(thumbPath);
          } catch {
            locationThumbUrl = null;
          }
        }
        if (thumb2dPath) {
          try {
            locationThumb2dUrl = await resolvePhoto(thumb2dPath);
          } catch {
            locationThumb2dUrl = null;
          }
        }
      }
    } catch {
      /* offline: counts-only print is still useful */
    }
    const src: Task | null = task;
    const fallback = queuedCreate;
    if (!src && !fallback) return;
    const input: PrintTaskView = {
      num: src?.num ?? 0,
      title: src?.title ?? fallback?.title ?? "",
      description: src?.description ?? fallback?.description ?? "",
      type: src?.type ?? "task",
      status,
      assigneeName: src?.assigneeName ?? null,
      deadline: src?.deadline ?? null,
      storeyName: (src?.location ?? fallback?.location ?? null)?.storeyName ?? null,
      hasBim: !!(src?.location ?? fallback?.location)?.bim?.worldPoint,
      pdfPage: (src?.location ?? fallback?.location)?.pdf?.page ?? null,
      createdBy: src?.createdBy ?? null,
      createdAt: src?.createdAt ?? null,
      entries: views,
      photoUrls,
      locationThumbUrl,
      locationThumb2dUrl,
      printedBy: actor.name,
    };
    openPrintView(buildTaskPrintHtml(input));
  }

  return (
    <TaskDetailView
      num={task?.num ?? 0}
      title={liveTask?.title ?? (queuedCreate?.title ?? "")}
      description={liveTask?.description ?? (queuedCreate?.description ?? "")}
      type={liveTask?.type ?? "task"}
      status={status}
      assigneeName={liveTask?.assigneeName ?? null}
      deadline={liveTask?.deadline ?? null}
      location={(liveTask?.location as TaskLocation | null | undefined) ?? (queuedCreate?.location ?? null)}
      entries={views}
      photoUrls={photoUrls}
      photos={task?.photos ?? []}
      createdBy={task?.createdBy ?? null}
      createdAt={task?.createdAt ?? null}
      updatedBy={updatedBy}
      updatedAt={updatedAt}
      projectName={projectName}
      buildingId={effectiveBuildingId}
      buildingName={effectiveBuildingId ? (buildings?.find((b) => b.id === effectiveBuildingId)?.name ?? null) : null}
      people={members ?? undefined}
      onAssign={assignTo}
      editable={caps.canWrite && !!engine && !!liveTask && status !== null && isEditableStatus(status)}
      startEditing={startEditing}
      assigneeUid={liveTask?.assigneeUid ?? null}
      priority={(liveTask?.priority as string | null | undefined) ?? null}
      checklist={normalizeChecklist(liveTask?.checklist)}
      watchers={normalizeWatchers(liveTask?.watchers)}
      sheetRefs={normalizeSheetRefs(liveTask?.sheetRefs ?? queuedCreate?.sheetRefs)}
      sheetCatalog={sheetCatalog}
      projectId={projectId ?? null}
      currentUid={actor.uid || null}
      extendedFields={caps.extendedFields}
      buildingOptions={buildings}
      onEditFields={editFields}
      onToggleWatch={toggleWatch}
      canDelete={caps.hardDelete && !!liveTask}
      onDelete={() => void deleteTask()}
      canAct={!!engine && (status !== null)}
      onComment={(t) => act("comment", t)}
      onTransition={(v) => act(v)}
      onRetryEntry={(guid) => {
        if (engine) void engine.retryNow(guid);
      }}
      // Hosts that own a viewer restore the view in place; anywhere else the
      // location card is quick access to the module the task was made in.
      // A task created in LinkView always opens LinkView (both sides), even
      // from a host that would otherwise restore only its own half in place.
      onShowIn3D={
        liveTask && isLinkviewLocation(taskLoc)
          ? () => openLocation(liveTask)
          : (onShowIn3D ?? (hasBimLoc && liveTask ? () => openLocation(liveTask) : undefined))
      }
      onShowOnPlan={
        liveTask && isLinkviewLocation(taskLoc)
          ? () => openLocation(liveTask)
          : (onShowOnPlan ?? (hasPdfLoc && liveTask ? () => openLocation(liveTask) : undefined))
      }
      onHideInstance={onHideInstance}
      onPrint={task || queuedCreate ? () => void handlePrint() : undefined}
      onClose={onClose}
      resolvePhotoUrl={resolvePhotoUrl}
    />
  );
}