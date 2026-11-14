import type { OutboxRecord } from "@ff/types";

/**
 * 3D callout math (plan §5, task-module "pin/restore in both spaces"
 * — the one non-cuttable scope). Pure and structural: the layer
 * talks to the viewer only through this file's minimal `CalloutHandle`
 * interface, so ff-tasks-react never has to import the viewer package
 * (D1: module package, no seventh-app coupling).
 */

/** World point / camera pose as persisted on task docs (§2.2, D1/D2). */
export type Vec3 = [number, number, number];
export interface PinPose {
  pos: Vec3;
  target: Vec3;
  fov: number;
  isOrtho: boolean;
}

/** The slice of a task doc the layer cares about — structural, so a
 *  full cloud `Task` satisfies it without widening ff-tasks' merge view. */
export interface LocatableTask {
  id: string;
  num: number;
  title: string;
  status: number;
  updatedAt: number;
  /** building scope; null/absent = legacy/cross-building */
  buildingId?: string | null;
  location?: {
    bim?: {
      elements?: { modelId: string; expressId: number }[];
      worldPoint?: Vec3 | null;
      cameraPose?: PinPose | null;
    } | null;
  } | null;
}

/** A task reduced to what a callout needs. */
export interface TaskPin {
  taskId: string;
  num: number;
  title: string;
  status: number;
  /** true for queued (not-yet-committed) pins — renders half-alpha (§4) */
  pending: boolean;
  worldPoint: Vec3;
  cameraPose: PinPose | null;
  elements: { modelId: string; expressId: number }[];
  /** building scope; absent = legacy/cross-building (shown everywhere) */
  buildingId?: string;
}

/**
 * Wave 63: how many recent tasks a pin layer subscribes to. The layers
 * used the list's 50-task window, so once a project had 50 newer tasks
 * the older pins silently vanished from the model and the plan. This
 * is a ceiling, not a page: Firestore needs a limit, and a layer with
 * more located tasks than this would be unreadable anyway.
 */
export const PIN_FEED_LIMIT = 2000;

/**
 * Pins of one building plus legacy/cross-building pins (no buildingId)
 * — the same rule as the task list's building scope. `undefined` keeps
 * every pin (a host without a building context).
 */
export function pinsForBuilding<T extends { buildingId?: string }>(
  pins: readonly T[],
  buildingId: string | null | undefined,
): T[] {
  if (buildingId === undefined) return [...pins];
  return pins.filter((p) => !p.buildingId || p.buildingId === buildingId);
}

/** `{ buildingId }` when set, else nothing (keeps legacy pins shape-equal). */
export function pinBuildingScope(buildingId: unknown): { buildingId?: string } {
  return typeof buildingId === "string" && buildingId.length > 0 ? { buildingId } : {};
}

/** Minimal viewer surface the layer uses (IfcViewerHandle satisfies it). */
export interface CalloutHandle {
  worldToScreen(point: { x: number; y: number; z: number }): { x: number; y: number } | null;
  /**
   * Wave 30: opaque "did the projection change?" token. Same value ⇒
   * the camera and the canvas size are unchanged, so re-projecting
   * world points cannot produce different screen pixels. Optional:
   * hosts that predate it (and test doubles) simply get the old
   * every-frame behavior, because the layer treats `undefined` as
   * "always dirty". Consumers must still re-project on a heartbeat —
   * this covers camera/viewport only, never world-point changes.
   */
  getViewportRevision?(): number;
  getContainer?(): HTMLElement | null;
  setViewPose?(pose: PinPose, options?: { animate?: boolean }): void;
  selectElement?(modelId: string | null, expressId: number | null): void;
  /** selection snapshot (modelId → Set<expressId>) — drives the marker */
  getSelection?(): ReadonlyMap<string, ReadonlySet<number>>;
  /** current viewpoint — captured into the pin's cameraPose (§0 idea 3) */
  getPose?(): PinPose | null;
  /**
   * Day-3 location snapshot: jpeg dataURL of the current 3D view
   * (IfcViewerHandle.getSnapshot), or null when capture fails.
   */
  getSnapshot?(maxWidthPx?: number): string | null;
  /**
   * World-space centre of the current selection's bounding box
   * (Wave 5B tap-to-create anchor). Async: the host resolves it via
   * the engine's BoundingBoxer. Returns null when there is no
   * selection, the world isn't ready, or the box is unusable.
   */
  getSelectionWorldCenter?(): Promise<{ x: number; y: number; z: number } | null>;
  /**
   * Wave 20 tap-to-create anchor (preferred over the bbox centre):
   * the REAL world point of the canvas pick that produced the
   * current selection. Synchronous — the viewer stashes it at pick
   * time. Returns null when the selection did not come from a canvas
   * pick (programmatic select, raycaster fallback) or the selection
   * has since changed; callers then fall back to
   * `getSelectionWorldCenter()`.
   */
  getSelectionWorldPoint?(): { x: number; y: number; z: number } | null;
  /**
   * Wave 21: true while the viewer's GPU depth pass for the CURRENT
   * canvas-pick selection is still in flight (selection + highlight
   * already applied from the id pass; the real click point lands
   * ~60 ms later). `TapCreateMarker3D` waits on this instead of
   * committing to the bbox-centre fallback.
   */
  isSelectionPointPending?(): boolean;
}

/** Cloud docs with a 3D anchor become pins; a null worldPoint means the
 *  pin is 2D-only (plan §6: it renders as an on-plan marker instead). */
export function extractPins(tasks: readonly LocatableTask[]): TaskPin[] {
  const pins: TaskPin[] = [];
  for (const task of tasks) {
    const bim = task.location?.bim;
    const wp = bim?.worldPoint;
    if (!wp || wp.length !== 3) continue;
    pins.push({
      taskId: task.id,
      num: task.num,
      title: task.title,
      status: task.status,
      pending: false,
      worldPoint: wp,
      cameraPose: bim?.cameraPose ?? null,
      elements: bim?.elements ?? [],
      ...pinBuildingScope(task.buildingId),
    });
  }
  return pins;
}

/**
 * Queued creates with a 3D location pin early (D5: only `added`/
 * `failed` overlay; `sending` is already optimistic in Firestore's
 * local cache). The pending pin renders from the outbox payload —
 * the same data that will become the cloud doc once the engine
 * commits it.
 */
export function pendingPins(rows: readonly OutboxRecord[], overlaySending = false): TaskPin[] {
  const pins: TaskPin[] = [];
  for (const row of rows) {
    const isPending =
      row.state === "added" || row.state === "failed" || (overlaySending && row.state === "sending");
    if (!isPending) continue;
    const payload = row.payload as unknown as {
      verb?: string;
      taskId?: string;
      title?: string;
      statusTo?: number;
      createDoc?: {
        num?: number;
        buildingId?: string | null;
        location?: LocatableTask["location"];
      };
    };
    if (payload.verb !== "create" || !payload.taskId) continue;
    const bim = payload.createDoc?.location?.bim;
    const wp = bim?.worldPoint;
    if (!wp || wp.length !== 3) continue;
    pins.push({
      taskId: payload.taskId,
      num: payload.createDoc?.num ?? 0,
      title: payload.title ?? "(untitled)",
      status: payload.statusTo ?? 10,
      pending: true,
      worldPoint: wp,
      cameraPose: bim?.cameraPose ?? null,
      elements: bim?.elements ?? [],
      ...pinBuildingScope(payload.createDoc?.buildingId),
    });
  }
  return pins;
}

/** Cloud pins hidden while a pending pin for the same task exists —
 *  until the engine commits, the pending row is the fresher truth. */
export function mergePins(cloud: TaskPin[], pending: TaskPin[]): TaskPin[] {
  const queued = new Set(pending.map((p) => p.taskId));
  return [...cloud.filter((p) => !queued.has(p.taskId)), ...pending];
}

/**
 * Wave 30: how often an overlay layer re-projects when the viewer
 * reports no viewport change. The projection token
 * (`CalloutHandle.getViewportRevision`) covers camera and canvas
 * size; this heartbeat is the safety net for everything else that can
 * move a pin on screen without touching either — a world point edited
 * under it, a layout shift, a host whose handle predates the token.
 * One burst per second costs nothing, and it bounds any staleness to
 * a second instead of "until the user orbits".
 */
export const IDLE_REPROJECT_MS = 1000;

/** One projection pass: null (off-screen behind camera / world not
 *  mounted) drops the callout for that frame — never drifts it. */
export function projectPins<T extends { worldPoint: Vec3 }>(
  pins: readonly T[],
  worldToScreen: CalloutHandle["worldToScreen"]
): (T & { x: number; y: number })[] {
  const out: (T & { x: number; y: number })[] = [];
  for (const p of pins) {
    const s = worldToScreen({ x: p.worldPoint[0], y: p.worldPoint[1], z: p.worldPoint[2] });
    if (s) out.push({ ...p, x: s.x, y: s.y });
  }
  return out;
}

/** "Open a task restores the author's viewpoint" (plan §0 idea 3) —
 *  pose first, then the element highlight rides the same selection
 *  surface the PropertiesDrawer uses. Idempotent; safe pre-mount
 *  (handle methods are internally guarded). */
export function restorePinView(handle: CalloutHandle, pin: TaskPin): void {
  if (pin.cameraPose) handle.setViewPose?.(pin.cameraPose, { animate: true });
  const first = pin.elements[0];
  if (first) handle.selectElement?.(first.modelId, first.expressId);
}

// ── Callout density (Wave 1A) ───────────────────────────────────────
//
// Many pins crowd the same corner of the model — overlapping chips are
// unreadable. The layer projects every pin each frame; the clusterer
// buckets the PROJECTED positions on a screen grid and folds each
// bucket into ONE chip.
//
// The representative is the LOWEST T-NUM in the bucket: a camera
// jitter moves pixels, and a lowest-number rule keeps the chip's
// identity stable instead of letting two chips swap tasks.

/** A projected pin reduced to what the clusterer needs. */
export interface ProjectedPin {
  /**
   * Stable identity. The clusterer reads the task number from the
   * LEADING INTEGER (`"<num>:<taskId>"`, as built by the layer), so a
   * bucket's representative is the lowest T-num. A key without a
   * leading number still works — it simply sorts after numbered ones.
   */
  key: string;
  x: number;
  y: number;
}

/** One screen-grid bucket of projected pins. */
export interface PinCluster {
  /** grid bucket coordinates (cellPx-sized cells) */
  bucketX: number;
  bucketY: number;
  /** the stable representative — lowest T-num in the bucket */
  representative: ProjectedPin;
  /** member keys, ascending (by task number, then key) */
  keys: string[];
  /** member count — 1 means "no cluster", the chip renders as before */
  count: number;
  /** centroid of the members (px) — where the chip is drawn */
  x: number;
  y: number;
}

/** Default cell size (px) of the clustering grid. */
export const DEFAULT_CLUSTER_CELL_PX = 48;

/** Task number carried by a cluster key — `Infinity` when the key has
 *  no leading number (so it never outranks a numbered pin). */
function taskNumFromKey(key: string): number {
  const m = /^(\d+)/.exec(key);
  if (!m) return Number.POSITIVE_INFINITY;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

/** Lexicographic compare that does not depend on the host locale. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold projected pins into screen-grid clusters.
 *
 * Pure: no DOM, no viewer, no clock. Only pins that are actually
 * visible belong here (the layer drops the off-screen ones BEFORE
 * projecting), so a cluster never counts a hidden pin.
 *
 * Output order is deterministic: by bucket (x, then y), then by the
 * representative's key.
 */
export function clusterProjectedPins(
  entries: readonly ProjectedPin[],
  cellPx: number = DEFAULT_CLUSTER_CELL_PX
): PinCluster[] {
  const cell = Number.isFinite(cellPx) && cellPx > 0 ? cellPx : DEFAULT_CLUSTER_CELL_PX;
  const buckets = new Map<string, { bx: number; by: number; list: ProjectedPin[] }>();
  for (const e of entries) {
    const bx = Math.floor(e.x / cell);
    const by = Math.floor(e.y / cell);
    const bucketKey = `${bx}:${by}`;
    const bucket = buckets.get(bucketKey);
    if (bucket) bucket.list.push(e);
    else buckets.set(bucketKey, { bx, by, list: [e] });
  }

  const clusters: PinCluster[] = [];
  for (const bucket of buckets.values()) {
    const sorted = [...bucket.list].sort(
      (a, b) => taskNumFromKey(a.key) - taskNumFromKey(b.key) || compareKeys(a.key, b.key)
    );
    const representative = sorted[0];
    let sx = 0;
    let sy = 0;
    for (const e of bucket.list) {
      sx += e.x;
      sy += e.y;
    }
    clusters.push({
      bucketX: bucket.bx,
      bucketY: bucket.by,
      representative,
      keys: sorted.map((e) => e.key),
      count: bucket.list.length,
      x: sx / bucket.list.length,
      y: sy / bucket.list.length,
    });
  }

  clusters.sort(
    (a, b) =>
      a.bucketX - b.bucketX ||
      a.bucketY - b.bucketY ||
      compareKeys(a.representative.key, b.representative.key)
  );
  return clusters;
}
