import type { TaskLocation } from "@ff/firestore";
import { dataUrlToBlob, locationThumb2dPath, locationThumbPath, LOCATION_THUMB_MIME } from "@ff/tasks";

import type { ComposeLocationThumb } from "./composeModel";

/** `location.origin` stamped on tasks created in LinkView (re-exported for the LinkView app). */
export { LINKVIEW_ORIGIN } from "@ff/tasks";
import { registerBlob } from "./useTaskEngine";

/**
 * Day-3 location snapshot seam: turn a capture dataURL (from
 * IfcViewerHandle.getSnapshot / PdfOverlayHandle.getPageSnapshot) into
 * the two things the compose sheet + outbox need:
 *
 *   - `location.thumb.storagePath` (the deterministic Storage path), and
 *   - a ComposeLocationThumb (the blob ref that rides the outbox + an
 *     object URL for the immediate card preview).
 *
 * A null/malformed dataURL (or a failed capture) returns the original
 * location untouched with `thumb: null` — the caller falls back to the
 * stylized placeholder and creation NEVER blocks.
 */

/** uuid with a jsdom/older-browser fallback (jsdom <22 lacks randomUUID). */
export function newUuid(): string {
  const c: Crypto | undefined =
    typeof globalThis !== "undefined" ? (globalThis as { crypto?: Crypto }).crypto : undefined;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface SnapshotThumbResult {
  location: TaskLocation;
  thumb: ComposeLocationThumb | null;
}

function attachThumb(
  dataUrl: string | null | undefined,
  storagePath: string,
  field: "thumb" | "thumb2d",
  location: TaskLocation,
): SnapshotThumbResult {
  if (!dataUrl) return { location, thumb: null };
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { location, thumb: null };
  const blobKey = newUuid();
  registerBlob(blobKey, blob);
  const previewUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : undefined;
  return {
    location: { ...location, [field]: { storagePath } },
    thumb: {
      blobKey,
      size: blob.size,
      mime: blob.type || LOCATION_THUMB_MIME,
      previewUrl,
    },
  };
}

export function attachSnapshotThumb(
  dataUrl: string | null | undefined,
  projectId: string,
  taskId: string,
  location: TaskLocation,
): SnapshotThumbResult {
  return attachThumb(dataUrl, locationThumbPath(projectId, taskId), "thumb", location);
}

/**
 * LinkView dual location: the PLAN snapshot. Same capture-to-blob path as
 * {@link attachSnapshotThumb}, stamped at `location.thumb2d` (its own
 * fixed Storage path) so the 3D `location.thumb` is untouched.
 */
export function attachPlanSnapshotThumb(
  dataUrl: string | null | undefined,
  projectId: string,
  taskId: string,
  location: TaskLocation,
): SnapshotThumbResult {
  return attachThumb(dataUrl, locationThumb2dPath(projectId, taskId), "thumb2d", location);
}

/**
 * Creation seam for hosts that store MORE than the tapped surface's own
 * location. LinkView registers one while mounted: a 3D tap there gets the
 * matching plan pin, plan snapshot and `origin: 'linkview'` added. With no
 * enricher (Models, Documents, Tasks) creation is untouched. A throwing
 * enricher is ignored: creation never blocks on it.
 */
export interface LocationEnrichment {
  location: TaskLocation;
  thumb2d: ComposeLocationThumb | null;
}
export type TaskLocationEnricher = (
  location: TaskLocation,
  ctx: { projectId: string; taskId: string },
) => LocationEnrichment | null;

let locationEnricher: TaskLocationEnricher | null = null;

export function setTaskLocationEnricher(fn: TaskLocationEnricher | null): void {
  locationEnricher = fn;
}

export function enrichTaskLocation(
  location: TaskLocation,
  ctx: { projectId: string; taskId: string },
): LocationEnrichment {
  if (!locationEnricher) return { location, thumb2d: null };
  try {
    return locationEnricher(location, ctx) ?? { location, thumb2d: null };
  } catch {
    return { location, thumb2d: null };
  }
}