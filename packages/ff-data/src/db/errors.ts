// src/db/errors.ts
//
// Typed storage errors the UI can show. IndexedDB reports a full disk
// / exhausted origin quota as a `QuotaExceededError` DOMException;
// Dexie wraps it (`Dexie.QuotaExceededError`, or an AbortError whose
// `inner` is the quota error). `toStorageError` normalises all of
// those into one `StorageQuotaExceededError` so callers can
// `instanceof`-check it instead of string-matching.

export class StorageQuotaExceededError extends Error {
  readonly code = "storage-quota-exceeded" as const;
  constructor(cause: unknown, message?: string) {
    super(
      message ??
        "Not enough browser storage to save this file. Free up disk space or delete older models/versions, then try again.",
      { cause },
    );
    this.name = "StorageQuotaExceededError";
  }
}

function errName(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const n = (e as { name?: unknown }).name;
  return typeof n === "string" ? n : undefined;
}

/** True for a quota error, however deeply Dexie wrapped it. */
export function isQuotaExceededError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 5; depth++) {
    const name = errName(cur);
    if (name === "QuotaExceededError" || name === "StorageQuotaExceededError") return true;
    const code = (cur as { code?: unknown }).code;
    if (code === 22 || code === 1014) return true; // legacy DOMException codes
    cur = (cur as { inner?: unknown; cause?: unknown }).inner ??
      (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Map a raw storage failure to a typed error (others pass through). */
export function toStorageError(e: unknown): unknown {
  if (e instanceof StorageQuotaExceededError) return e;
  if (isQuotaExceededError(e)) return new StorageQuotaExceededError(e);
  return e;
}
