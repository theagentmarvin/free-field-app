import {
  isTaskPriority,
  normalizeChecklist,
  type BcfBinary,
  type BcfComponent,
  type BcfEntrySource,
  type BcfPhoto,
  type BcfTaskBundle,
  type BcfTaskSource,
  type BcfUserDirectory,
  type BcfVersion,
  type BcfWarning,
  type Vec3,
} from "@ff/tasks";
import type { Task, TaskEntry } from "@ff/firestore";

import type { TaskTableRow } from "./tableColumns";
import type { TasksSource } from "./tasksSource";

/**
 * BCF export — the integration half (the pure writer lives in
 * @ff/tasks `bcf/`). Everything here is injected so it is testable
 * without Firestore, the viewer or the DOM: scope selection, the
 * per-task bundle builder, the user directory and the toast text.
 * Spec: docs/specs/tasks-bcf-export.md
 */

/** Hard cap on topics per file. */
export const BCF_MAX_TOPICS = 500;
/** Parallel tasks being gathered at once. */
export const BCF_CONCURRENCY = 4;
/** Total photo bytes allowed in one export; beyond it photos are left out (snapshots are kept). */
export const BCF_MAX_PHOTO_BYTES = 250 * 1024 * 1024;
/** How long a one-shot subscription may wait for its first snapshot. */
export const BCF_ONESHOT_TIMEOUT_MS = 6000;

/** Host-supplied resolvers (the package must not import the viewer or settings). */
export interface TasksBcfContext {
  /** IFC GlobalIds for linked elements; null entries = unresolved. */
  resolveGlobalIds?(
    buildingId: string | null,
    elements: { modelId: string; expressId: number }[],
  ): Promise<Array<{ ifcGuid: string; originatingSystem?: string; authoringToolId?: string } | null>>;
  /** Base shift: FreeField world = (ifcX, ifcZ, -ifcY) + shift; null = unknown. */
  resolveBaseShift?(buildingId: string | null): Promise<[number, number, number] | null>;
  /** Deep link to a task. */
  taskUrl?(taskId: string): string | null;
}

// ── scope ────────────────────────────────────────────────────────────

export interface BcfScope<T> {
  rows: T[];
  /** rows available before the cap */
  total: number;
  capped: boolean;
  /** true when the scope is the selection (not the whole view) */
  fromSelection: boolean;
}

/** Selected rows when any are selected, else the current view; capped. */
export function selectBcfScope<T>(selected: readonly T[], view: readonly T[], max = BCF_MAX_TOPICS): BcfScope<T> {
  const fromSelection = selected.length > 0;
  const all = fromSelection ? selected : view;
  return { rows: all.slice(0, max), total: all.length, capped: all.length > max, fromSelection };
}

// ── user directory ───────────────────────────────────────────────────

export interface BcfPerson {
  uid: string;
  name?: string | null;
  email?: string | null;
}

/** Email if known, else display name, else uid (spec: author string). */
export function buildBcfUserDirectory(people: readonly BcfPerson[]): BcfUserDirectory {
  const byUid = new Map<string, BcfPerson>();
  const byName = new Map<string, BcfPerson>();
  for (const p of people) {
    const prev = byUid.get(p.uid);
    byUid.set(p.uid, { ...prev, ...p, email: p.email || prev?.email || null, name: p.name || prev?.name || null });
  }
  for (const p of byUid.values()) {
    if (p.name && !byName.has(p.name)) byName.set(p.name, p);
  }
  const clean = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);
  return {
    author(uid, fallbackName) {
      const p = uid ? byUid.get(uid) : undefined;
      return clean(p?.email) ?? clean(p?.name) ?? clean(fallbackName) ?? clean(uid);
    },
    authorByName(name) {
      const n = clean(name);
      if (!n) return null;
      const p = byName.get(n);
      return clean(p?.email) ?? n;
    },
  };
}

// ── sheet pin note ───────────────────────────────────────────────────

const pct = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 100);

/** "Sheet A101 · page 1 · at 42 %, 61 %" (uv in 0..1, top-left origin). */
export function sheetPinNote(
  pdf: { pdfFileId: string; page: number; uv: readonly [number, number] },
  names: { sheetRefs?: readonly { pdfFileId: string; name: string }[]; lookup?: (pdfFileId: string) => string | null | undefined },
): string {
  const name =
    names.sheetRefs?.find((s) => s.pdfFileId === pdf.pdfFileId)?.name?.trim() ||
    names.lookup?.(pdf.pdfFileId)?.trim() ||
    "(unknown)";
  return `Sheet ${name} · page ${pdf.page} · at ${pct(pdf.uv[0])} %, ${pct(pdf.uv[1])} %`;
}

// ── one-shot subscriptions ───────────────────────────────────────────

/** First callback of a live subscription, then unsubscribe. Resolves
 *  `fallback` after `timeoutMs` (and unsubscribes then too). */
export function firstValue<T>(
  subscribe: (cb: (v: T) => void) => () => void,
  fallback: T,
  timeoutMs = BCF_ONESHOT_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (v: T): void => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      // the callback may fire before subscribe() returned
      if (unsub) unsub();
      resolve(v);
    };
    try {
      unsub = subscribe((v) => {
        finish(v);
      });
    } catch {
      finish(fallback);
      return;
    }
    if (done) {
      unsub?.();
      return;
    }
    timer = setTimeout(() => finish(fallback), timeoutMs);
  });
}

// ── bundle builder ───────────────────────────────────────────────────

export interface BuildBcfDeps {
  projectId: string;
  source: Pick<TasksSource, "watchTask" | "watchTaskEntries">;
  /** Storage path → bytes (null when unavailable). `measure` asks for pixel size. */
  fetchBinary(storagePath: string, opts: { mime?: string; measure?: boolean }): Promise<BcfBinary | null>;
  /** Sheet name by pdfFileId (project catalog); optional. */
  sheetName?(pdfFileId: string): string | null | undefined;
  /** Absent = export without components and without a camera (snapshot only). */
  context?: TasksBcfContext;
  onProgress?(done: number, total: number): void;
  /** Photo byte budget (default BCF_MAX_PHOTO_BYTES). */
  maxPhotoBytes?: number;
  concurrency?: number;
  timeoutMs?: number;
}

export interface BuiltBcf {
  bundles: BcfTaskBundle[];
  /** Base shift per task id (null = unknown). */
  shifts: Map<string, Vec3 | null>;
  /** Photos whose bytes could not be fetched (left out of the bundles). */
  skippedPhotos: number;
  /** Photos left out because the photo byte budget was reached. */
  budgetSkippedPhotos: number;
}

type LooseTask = Partial<Task> &
  TaskTableRow & {
    priority?: string | null;
    checklist?: unknown;
  };

function asBinaryMime(mime: string | undefined): string | undefined {
  return mime && mime.startsWith("image/") ? mime : undefined;
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

function cameraOf(task: LooseTask): BcfTaskSource["cameraPose"] {
  const cp = (task.location as { bim?: { cameraPose?: unknown } | null } | null | undefined)?.bim?.cameraPose as
    | { pos?: unknown; target?: unknown; fov?: unknown; isOrtho?: unknown }
    | null
    | undefined;
  if (!cp || !isVec3(cp.pos) || !isVec3(cp.target)) return null;
  return {
    pos: cp.pos,
    target: cp.target,
    fov: typeof cp.fov === "number" && Number.isFinite(cp.fov) ? cp.fov : 60,
    isOrtho: cp.isOrtho === true,
  };
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Gather everything the writer needs for each row. Rows are the merged
 * list rows; the full task doc is fetched one-shot because the merge
 * normalises `photos` down to `{storagePath}` (mime/caption are lost).
 */
export async function buildBcfBundles(rows: readonly TaskTableRow[], deps: BuildBcfDeps): Promise<BuiltBcf> {
  const ctx = deps.context;
  const timeout = deps.timeoutMs ?? BCF_ONESHOT_TIMEOUT_MS;
  const shifts = new Map<string, Vec3 | null>();
  const shiftByBuilding = new Map<string, Promise<Vec3 | null>>();
  const shiftFor = (buildingId: string | null): Promise<Vec3 | null> => {
    if (!ctx?.resolveBaseShift) return Promise.resolve(null);
    const key = buildingId ?? "";
    let p = shiftByBuilding.get(key);
    if (!p) {
      p = ctx.resolveBaseShift(buildingId).then(
        (s) => (s && isVec3(s) ? s : null),
        () => null,
      );
      shiftByBuilding.set(key, p);
    }
    return p;
  };

  let done = 0;
  let skippedPhotos = 0;
  let budgetSkippedPhotos = 0;
  let photoBytes = 0;
  const maxPhotoBytes = deps.maxPhotoBytes ?? BCF_MAX_PHOTO_BYTES;
  deps.onProgress?.(0, rows.length);

  const bundles = await pool(rows, deps.concurrency ?? BCF_CONCURRENCY, async (row): Promise<BcfTaskBundle> => {
    const [fullTask, entryDocs] = await Promise.all([
      firstValue<Task | null>((cb) => deps.source.watchTask(deps.projectId, row.id, cb), null, timeout),
      firstValue<TaskEntry[]>((cb) => deps.source.watchTaskEntries(deps.projectId, row.id, cb), [], timeout),
    ]);
    // Row fields (building/storey enrichment) win over nothing; the doc wins for photos/location.
    const t = { ...row, ...(fullTask ?? {}) } as LooseTask;
    const enriched = row as TaskTableRow;
    const buildingId = (t.buildingId ?? null) as string | null;
    const loc = (t.location ?? null) as {
      storeyName?: string | null;
      text?: string;
      thumb?: { storagePath?: string };
      bim?: { elements?: { modelId: string; expressId: number }[] } | null;
      pdf?: { pdfFileId: string; page: number; uv: [number, number] } | null;
    } | null;

    const shift = await shiftFor(buildingId);
    shifts.set(row.id, shift);

    const sheetRefs = (t.sheetRefs ?? []) as readonly { pdfFileId: string; name: string; page?: number; versionNumber?: number }[];
    const camera = ctx?.resolveBaseShift ? cameraOf(t) : null;

    const task: BcfTaskSource = {
      id: t.id,
      num: t.num,
      title: t.title,
      description: t.description ?? "",
      type: t.type ?? "task",
      status: t.status,
      priority: isTaskPriority(t.priority) ? t.priority : null,
      checklist: normalizeChecklist(t.checklist).map((c) => ({ text: c.text, done: c.done })),
      createdAt: t.createdAt ?? t.updatedAt,
      createdByUid: t.createdByUid ?? "",
      createdBy: t.createdBy ?? "",
      updatedAt: t.updatedAt,
      updatedBy: t.updatedBy ?? "",
      assigneeUid: t.assigneeUid ?? null,
      assigneeName: t.assigneeName ?? null,
      deadline: t.deadline ?? null,
      buildingName: enriched.buildingName ?? null,
      storeyName: enriched.storeyName ?? loc?.storeyName ?? null,
      locationText: loc?.text ?? null,
      sheetPinNote: loc?.pdf
        ? sheetPinNote(loc.pdf, { sheetRefs, lookup: deps.sheetName })
        : null,
      sheetRefs: sheetRefs.map((s) => ({ name: s.name, page: s.page, versionNumber: s.versionNumber })),
      cameraPose: camera,
    };

    const entries: BcfEntrySource[] = [...entryDocs]
      .sort((a, b) => a.at - b.at)
      .map((e) => ({
        id: e.id,
        action: e.action,
        text: e.text ?? "",
        by: e.by,
        byUid: e.byUid,
        at: e.at,
        statusFrom: e.statusFrom ?? null,
        statusTo: e.statusTo ?? null,
      }));

    // snapshot
    const thumbPath = loc?.thumb?.storagePath ?? t.locationThumbPath ?? null;
    const snapshot = thumbPath ? await safeFetch(deps, thumbPath, { mime: "image/jpeg", measure: true }) : null;

    // photos: task photos then entry photos
    const photoRefs: { path: string; mime?: string; caption?: string | null; entryId?: string | null }[] = [];
    const taskPhotos = ((fullTask as Task | null)?.photos ?? t.photos ?? []) as { storagePath: string; mime?: string; caption?: string }[];
    for (const p of taskPhotos) photoRefs.push({ path: p.storagePath, mime: p.mime, caption: p.caption ?? null });
    for (const e of entryDocs) {
      for (const p of e.photos ?? []) photoRefs.push({ path: p.storagePath, mime: p.mime, caption: p.caption ?? null, entryId: e.id });
    }
    const photos: BcfPhoto[] = [];
    // The creation entry repeats the task photos (same storage path): one file each.
    const seenPaths = new Set<string>();
    for (const ref of photoRefs) {
      if (seenPaths.has(ref.path)) continue;
      seenPaths.add(ref.path);
      if (photoBytes >= maxPhotoBytes) {
        budgetSkippedPhotos++;
        continue;
      }
      const binary = await safeFetch(deps, ref.path, { mime: asBinaryMime(ref.mime) });
      if (!binary) {
        skippedPhotos++;
        continue;
      }
      if (photoBytes + binary.bytes.byteLength > maxPhotoBytes) {
        budgetSkippedPhotos++;
        photoBytes = maxPhotoBytes; // stop adding photos from here on
        continue;
      }
      photoBytes += binary.bytes.byteLength;
      photos.push({ binary, caption: ref.caption ?? null, entryId: ref.entryId ?? null });
    }

    // components
    let components: BcfComponent[] | undefined;
    let unresolved = 0;
    const elements = loc?.bim?.elements ?? [];
    if (elements.length > 0 && ctx?.resolveGlobalIds) {
      try {
        const res = await ctx.resolveGlobalIds(buildingId, elements.map((e) => ({ modelId: e.modelId, expressId: e.expressId })));
        components = [];
        elements.forEach((_, i) => {
          const r = res[i];
          if (r && r.ifcGuid) components!.push({ ifcGuid: r.ifcGuid, originatingSystem: r.originatingSystem, authoringToolId: r.authoringToolId });
          else unresolved++;
        });
      } catch {
        components = [];
        unresolved = elements.length;
      }
    }

    done++;
    deps.onProgress?.(done, rows.length);
    const bundle: BcfTaskBundle = { task, entries, snapshot, photos };
    if (components) bundle.components = components;
    if (unresolved > 0) bundle.unresolvedComponents = unresolved;
    return bundle;
  });

  return { bundles, shifts, skippedPhotos, budgetSkippedPhotos };
}

async function safeFetch(
  deps: BuildBcfDeps,
  path: string,
  opts: { mime?: string; measure?: boolean },
): Promise<BcfBinary | null> {
  try {
    return await deps.fetchBinary(path, opts);
  } catch {
    return null;
  }
}

// ── toast text ───────────────────────────────────────────────────────

export function bcfDoneMessage(
  count: number,
  version: BcfVersion,
  warnings: readonly BcfWarning[],
  photos: { skipped?: number; budgetSkipped?: number } = {},
): string {
  const without3d = new Set(warnings.filter((w) => w.kind === "no-3d-view").map((w) => w.taskId)).size;
  const skipped = photos.skipped ?? 0;
  const overBudget = photos.budgetSkipped ?? 0;
  return (
    `Exported ${count} task${count === 1 ? "" : "s"} to BCF ${version}` +
    (without3d > 0 ? ` · ${without3d} without 3D view` : "") +
    (skipped > 0 ? ` · ${skipped} photo${skipped === 1 ? "" : "s"} skipped` : "") +
    (overBudget > 0 ? ` · photo size limit reached, ${overBudget} photo${overBudget === 1 ? "" : "s"} left out` : "")
  );
}

export function bcfCapMessage(total: number, max = BCF_MAX_TOPICS): string {
  return `capped at ${max} of ${total}`;
}

export function bcfProgressMessage(done: number, total: number): string {
  return `Preparing BCF… ${done} / ${total}`;
}
