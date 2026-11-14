// apps/linkview/src/linkviewMode.ts
//
// Wave 52 — the Linkview layout mode (Split View | Overlap) + its
// localStorage persistence. Pure module (no React), so the toggle's
// persisted state is unit-testable without a component mount.

export type LinkviewMode = "split" | "overlap";

const STORAGE_KEY = "ff:linkview:mode";

/** Read the persisted mode. Defaults to `"split"` (the spec default). */
export function loadLinkviewMode(): LinkviewMode {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "split" || raw === "overlap") return raw;
  } catch {
    // localStorage may be disabled (private mode, etc.) — default.
  }
  return "split";
}

/** Persist the mode. Failures are swallowed (private mode, quota). */
export function persistLinkviewMode(mode: LinkviewMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}