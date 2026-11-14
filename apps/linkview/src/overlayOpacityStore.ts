// apps/linkview/src/overlayOpacityStore.ts
//
// Wave 63 — opacity of the floor-plan PDF drawn over the model in
// Overlap mode. Shared between the bottom <LinkviewToolbar> (which owns
// the slider) and <LinkviewApp> (which feeds useFloorPlanOverlay), and
// persisted to localStorage (same pattern as linkviewMode.ts).
//
// Stored as an integer percent (0..100) — what the slider shows.

import { create } from "zustand";

export const OVERLAY_OPACITY_STORAGE_KEY = "ff:linkview:overlayOpacity";

/** Default overlay opacity, percent. Mostly PDF, model still visible. */
export const DEFAULT_OVERLAY_OPACITY_PCT = 85;

/** Clamp + round to an integer percent; non-numbers → default. */
export function normalizeOverlayOpacityPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_OVERLAY_OPACITY_PCT;
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** Read the persisted percent. Falls back to the default. */
export function loadOverlayOpacityPct(): number {
  try {
    const raw = window.localStorage.getItem(OVERLAY_OPACITY_STORAGE_KEY);
    if (raw !== null && raw.trim() !== "") return normalizeOverlayOpacityPct(raw);
  } catch {
    // localStorage disabled (private mode, etc.) — default.
  }
  return DEFAULT_OVERLAY_OPACITY_PCT;
}

/** Persist the percent. Failures are swallowed (private mode, quota). */
export function persistOverlayOpacityPct(pct: number): void {
  try {
    window.localStorage.setItem(
      OVERLAY_OPACITY_STORAGE_KEY,
      String(normalizeOverlayOpacityPct(pct)),
    );
  } catch {
    // ignore
  }
}

interface OverlayOpacityState {
  /** 0..100 */
  pct: number;
  setPct: (pct: number) => void;
}

export const useOverlayOpacityStore = create<OverlayOpacityState>((set) => ({
  pct: loadOverlayOpacityPct(),
  setPct: (pct) => {
    const next = normalizeOverlayOpacityPct(pct);
    persistOverlayOpacityPct(next);
    set({ pct: next });
  },
}));
