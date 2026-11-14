/**
 * Photo helpers (plan §2.3 D3): SHA-named Storage paths, computed at
 * attach time so a crash between compose and send still restores.
 * `composePhotoPath` MUST stay byte-identical to ff-tasks'
 * repository `photoPath(payload, i)` — the executor recomputes the
 * authoritative path from the final payload at commit; a parity test
 * pins the two.
 */

export function sha256Hex(data: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", data).then((digest) => {
    const bytes = new Uint8Array(digest);
    let hex = "";
    for (const b of bytes) hex += b.toString(16).padStart(2, "0");
    return hex;
  });
}

export function photoExtFor(mime: string): string {
  return mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

export function composePhotoPath(
  projectId: string,
  taskId: string,
  index: number,
  sha256: string,
  mime: string
): string {
  return `projects/${projectId}/tasks/${taskId}/${sha256.slice(0, 12)}-${index}.${photoExtFor(mime)}`;
}

/**
 * Location-snapshot deterministic Storage path (Day-3 location thumb).
 * Fixed name — NOT sha-named — so a re-captured snapshot always lands
 * at the same path and the executor's exists() check dedupes by path.
 *
 * Delegation note: this deliberately matches the photos family prefix
 * (`projects/{pid}/tasks/{taskId}/…`) so the existing photos pattern in
 * storage.rules (`/projects/{pid}/tasks/{taskId}/{photoId}`) covers the
 * thumb with NO rules extension — `location-thumb.jpg` is a valid
 * `{photoId}` and the contentType/size guards already admit jpeg.
 */
export function locationThumbPath(projectId: string, taskId: string): string {
  return `projects/${projectId}/tasks/${taskId}/location-thumb.jpg`;
}

/** Mime type the snapshot capturer always emits (canvas jpeg). */
export const LOCATION_THUMB_MIME = "image/jpeg";

/**
 * Convert a canvas `toDataURL("image/jpeg", …)` string back into a Blob
 * for the registerBlob → outbox upload path (snapshot bytes ride the
 * outbox exactly like photos). Returns null on a malformed/unsupported
 * data URL (the caller then falls back to the stylized placeholder).
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  if (typeof dataUrl !== "string") return null;
  const m = /^data:([^;,]+);base64,(.+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    const mime = m[1];
    const binary = atob(m[2]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}
