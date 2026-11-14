import type { TaskLocation } from "@ff/firestore";
import { dataUrlToBlob, locationThumbPath, LOCATION_THUMB_MIME } from "@ff/tasks";

import type { ComposeLocationThumb } from "./composeModel";
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

export function attachSnapshotThumb(
  dataUrl: string | null | undefined,
  projectId: string,
  taskId: string,
  location: TaskLocation,
): SnapshotThumbResult {
  if (!dataUrl) return { location, thumb: null };
  const blob = dataUrlToBlob(dataUrl);
  if (!blob) return { location, thumb: null };
  const storagePath = locationThumbPath(projectId, taskId);
  const blobKey = newUuid();
  registerBlob(blobKey, blob);
  const previewUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(blob)
      : undefined;
  return {
    location: { ...location, thumb: { storagePath } },
    thumb: {
      blobKey,
      size: blob.size,
      mime: blob.type || LOCATION_THUMB_MIME,
      previewUrl,
    },
  };
}