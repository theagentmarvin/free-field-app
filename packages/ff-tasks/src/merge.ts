import type { OutboxRecord } from "@ff/types";

import type { TaskActionPayload } from "./action";
import { composePhotoPath } from "./photos";

/**
 * Optimistic view merge (plan §4, task-39 D5).
 *
 * Wave 63: `sending` rows are overlaid on the cloud path too. The
 * engine writes with Firestore TRANSACTIONS, which never touch the
 * local cache before the server acknowledges them, so a row that is
 * in flight — or parked in `sending` while it backs off — was simply
 * invisible. Dedupe: a create never overrides a doc that already
 * exists (same task id), and a `sending` action is skipped once the
 * cloud doc already carries its timestamp (it landed; the row has not
 * flipped to `sent` yet).
 */

export interface TaskView {
  id: string;
  num: number;
  title: string;
  status: number;
  updatedAt: number;
  assigneeName: string | null;
  lastAction: string;
  entryCount: number;
  /** passthrough from the cloud doc / queued create — drives the
   *  list's deadline badge + sort (@ff/tasks-react logic.ts) */
  deadline?: number | null;
  /** Tasks UI-refresh v1: building scope passthrough. `null`/absent =
   *  legacy/cross-building — renders "—" and stays visible in BOTH
   *  building scopes (never orphaned). */
  buildingId?: string | null;
  assigneeUid?: string | null;
  createdAt?: number;
  /** rendered striped/half-alpha (§4) */
  pending?: boolean;
  /** rendered with the red ⚠ badge (§4) */
  failed?: boolean;
  /** photo evidence carried by the task doc (ff-firestore `photos[]`).
   *  The list renders a 24px thumb from the FIRST entry's storagePath —
   *  the bytes live in Storage, the doc only carries the path. */
  photos?: { storagePath: string }[];
  /** Day-3 location snapshot thumb. Storage path only (bytes live in
   *  Storage); resolved through usePhotoUrl for list/table/detail/print. */
  locationThumbPath?: string | null;
  /** Passthrough doc fields (detail editor / bulk / export). */
  description?: string;
  type?: string | null;
  createdBy?: string | null;
  /** w69 additive fields (rules-gated in the cloud, see taskFields.ts). */
  priority?: string | null;
  checklist?: { id: string; text: string; done: boolean }[];
  watchers?: string[];
  /** project sheets attached by reference (see taskFields.ts SheetRef) */
  sheetRefs?: { pdfFileId: string; pdfVersionId: string; versionNumber?: number; name: string; page?: number }[];
  location?: {
    storeyName?: string | null;
    text?: string;
    bim?: { elements?: unknown[] } | null;
    pdf?: unknown | null;
  } | null;
}

type CloudTask = TaskView; // Task docs satisfy TaskView structurally

/** Keep only the entries that carry a usable Storage path, in order.
 *  The list only ever needs the FIRST path, but the whole set rides
 *  along so a host can pick a different one later. */
function normalizePhotos(value: unknown): { storagePath: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { storagePath: string }[] = [];
  for (const item of value) {
    const path = (item as { storagePath?: unknown } | null)?.storagePath;
    if (typeof path === "string" && path.length > 0) out.push({ storagePath: path });
  }
  return out.length > 0 ? out : undefined;
}

/** Location snapshot thumb path from a task doc's (or pending create's)
 *  `location.thumb.storagePath`, or null when absent. */
export function normalizeLocationThumbPath(value: unknown): string | null {
  const thumb = (value as { thumb?: { storagePath?: unknown } } | null | undefined)?.thumb;
  const path = thumb?.storagePath;
  return typeof path === "string" && path.length > 0 ? path : null;
}

/** `location.origin` value stamped on tasks created in LinkView. */
export const LINKVIEW_ORIGIN = 'linkview';

/** Plan snapshot path from `location.thumb2d.storagePath`, or null. */
export function normalizeLocationThumb2dPath(value: unknown): string | null {
  const thumb = (value as { thumb2d?: { storagePath?: unknown } } | null | undefined)?.thumb2d;
  const path = thumb?.storagePath;
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/** A task created in LinkView: origin marker AND both a 3D and a plan side. */
export function isLinkviewLocation(value: unknown): boolean {
  const loc = value as { origin?: unknown; bim?: unknown; pdf?: unknown } | null | undefined;
  return !!loc && loc.origin === LINKVIEW_ORIGIN && !!loc.bim && !!loc.pdf;
}

/** LinkView task that also has BOTH snapshots (renders side by side). */
export function isDualThumbLocation(value: unknown): boolean {
  return (
    isLinkviewLocation(value) &&
    normalizeLocationThumbPath(value) !== null &&
    normalizeLocationThumb2dPath(value) !== null
  );
}

/** Queued rows know their own photo paths: the payload carries the
 *  sha-named refs, and the path is deterministic (photos.ts) — the
 *  executor recomputes the same string at commit. A queued CREATE
 *  additionally carries the doc-shaped `createDoc.photos`. */
export function queuedPhotoPaths(payload: TaskActionPayload): { storagePath: string }[] | undefined {
  const fromDoc = normalizePhotos(payload.createDoc?.photos);
  if (fromDoc) return fromDoc;
  const refs = payload.photoRefs;
  if (!Array.isArray(refs) || refs.length === 0) return undefined;
  const out = refs.map((r, i) => ({
    storagePath: composePhotoPath(payload.projectId, payload.taskId, i, r.sha256, r.mime),
  }));
  return out.length > 0 ? out : undefined;
}

export interface MergeOptions {
  /** Overlay `sending` rows (default true). Kept as an opt-out for
   *  callers that already render in-flight rows themselves. */
  overlaySending?: boolean;
}

/** True when a `sending` action's effect is already in the cloud doc
 *  (the doc's updatedAt is the committed action's client `at`). */
export function sendingActionLanded(
  row: { state: string },
  cloudUpdatedAt: number | undefined,
  actionAt: number | undefined,
): boolean {
  return (
    row.state === "sending" &&
    cloudUpdatedAt !== undefined &&
    actionAt !== undefined &&
    cloudUpdatedAt >= actionAt
  );
}

function isOverlayState(state: string, overlaySending: boolean): boolean {
  return state === "added" || state === "failed" || (overlaySending && state === "sending");
}

/** Doc fields a queued `patch` may optimistically change in the list. */
const PATCH_OVERLAY_KEYS = [
  'title',
  'description',
  'type',
  'deadline',
  'assigneeUid',
  'assigneeName',
  'buildingId',
  'priority',
  'checklist',
  'watchers',
  'sheetRefs',
  'location',
] as const;

function applyPatchOverlay(target: TaskView, patch: Record<string, unknown> | undefined): void {
  if (!patch) return;
  const t = target as unknown as Record<string, unknown>;
  for (const k of PATCH_OVERLAY_KEYS) {
    if (k in patch) t[k] = patch[k];
  }
}

export function mergeTaskViews(
  cloud: CloudTask[],
  rows: OutboxRecord[],
  opts: MergeOptions = {},
): TaskView[] {
  const overlaySending = opts.overlaySending !== false;
  const byId = new Map<string, TaskView>(
    cloud.map((t) => {
      const view: TaskView = { ...t };
      const photos = normalizePhotos(t.photos);
      if (photos) view.photos = photos;
      else delete view.photos;
      const locationThumbPath = normalizeLocationThumbPath(
        (t as unknown as { location?: unknown }).location,
      );
      if (locationThumbPath) view.locationThumbPath = locationThumbPath;
      else delete view.locationThumbPath;
      return [t.id, view];
    }),
  );

  const cloudUpdatedAt = new Map(cloud.map((t) => [t.id, t.updatedAt]));
  const pending = rows
    .filter((r) => isOverlayState(r.state, overlaySending))
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const row of pending) {
    const payload = row.payload as unknown as TaskActionPayload;
    const existing = byId.get(payload.taskId);
    if (payload.verb === "create" && !existing) {
      // Synthesize the not-yet-created doc from the queued payload.
      const doc = (payload.createDoc ?? {}) as Record<string, unknown>;
      byId.set(payload.taskId, {
        id: payload.taskId,
        num: (doc.num as number) ?? 0,
        title: payload.title,
        status: payload.statusTo,
        updatedAt: payload.at,
        assigneeName: (doc.assigneeName as string) ?? null,
        assigneeUid: (doc.assigneeUid as string) ?? null,
        deadline: (doc.deadline as number) ?? null,
        buildingId: (doc.buildingId as string) ?? null,
        description: (doc.description as string) ?? '',
        type: (doc.type as string) ?? null,
        createdBy: payload.actor?.name ?? null,
        priority: (doc.priority as string) ?? null,
        checklist: (doc.checklist as TaskView['checklist']) ?? undefined,
        watchers: (doc.watchers as string[]) ?? undefined,
        sheetRefs: (doc.sheetRefs as TaskView['sheetRefs']) ?? undefined,
        location: (doc.location as TaskView['location']) ?? null,
        createdAt: payload.at,
        lastAction: payload.verb,
        entryCount: 1,
        pending: true,
        failed: row.state === "failed",
        photos: queuedPhotoPaths(payload),
        locationThumbPath: normalizeLocationThumbPath(doc.location),
      });
      continue;
    }
    const target = existing ?? byId.get(row.resultTaskId ?? payload.taskId);
    if (!target) continue; // action on a doc we can't see yet — no overlay
    if (sendingActionLanded(row, cloudUpdatedAt.get(target.id), payload.at)) continue;
    target.status = payload.statusTo;
    target.lastAction = payload.verb;
    target.updatedAt = Math.max(target.updatedAt, payload.at);
    target.entryCount = target.entryCount + 1;
    target.pending = true;
    target.failed = row.state === "failed";
    if (payload.title) target.title = payload.title;
    applyPatchOverlay(target, payload.patch);
  }

  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
