// apps/documents/src/compare/compareStore.ts
//
// Compare revisions — UI state. The engine (compare/engine) is injected
// into `run`, so the store never imports it. Auto-run on settings change
// lives in a hook in the panel (useAutoRun), not here.

import { create } from "zustand";

import type { PdfVersionRecord } from "@ff/types";

import {
  DEFAULT_COMPARE_SETTINGS,
  type CompareMode,
  type CompareProgress,
  type CompareResult,
  type CompareSettings,
  type CompareSide,
  type RunCompare,
} from "./types";

export type CompareStatus = "idle" | "running" | "done" | "error";

export interface OverlayColors {
  base: string;
  revision: string;
  shared: string;
}

export const DEFAULT_OVERLAY_COLORS: OverlayColors = {
  base: "#e5484d",
  revision: "#3b82f6",
  shared: "#1f2328",
};

export interface ComparePrefill {
  base: CompareSide;
  revision: CompareSide;
}

/**
 * Previous version as Base, the open (or latest) version as Revision, page 1.
 * `versions` is ascending by versionNumber. With a single version both sides
 * are that version. Returns null when there are no versions.
 */
export function buildPrefill(
  versions: readonly PdfVersionRecord[],
  openVersionId?: string | null,
): ComparePrefill | null {
  if (versions.length === 0) return null;
  const sorted = [...versions].sort((a, b) => a.versionNumber - b.versionNumber);
  let idx = openVersionId ? sorted.findIndex((v) => v.id === openVersionId) : -1;
  if (idx < 0) idx = sorted.length - 1;
  const rev = sorted[idx]!;
  const base = sorted[idx - 1] ?? rev;
  return {
    base: { pdfFileId: base.pdfFileId, pdfVersionId: base.id, page: 1 },
    revision: { pdfFileId: rev.pdfFileId, pdfVersionId: rev.id, page: 1 },
  };
}

interface CompareState {
  active: boolean;
  /** Building the compare was opened in (a switch made elsewhere must end it). */
  buildingId: string | null;
  base: CompareSide | null;
  revision: CompareSide | null;
  /** Sides the current `result` was computed from (for pane labels). */
  resultSides: { base: CompareSide; revision: CompareSide } | null;
  mode: CompareMode;
  settings: CompareSettings;
  overlayColors: OverlayColors;
  status: CompareStatus;
  progress: CompareProgress | null;
  result: CompareResult | null;
  error: string | null;
  selectedRegionId: number | null;
  /** Bumped on every region selection so re-selecting re-centres the view. */
  focusNonce: number;
  reviewed: number[];
  syncViews: boolean;
  layerVisibility: { base: boolean; revision: boolean };
  layerOpacity: { base: number; revision: number };

  open: (prefill?: ComparePrefill | null, buildingId?: string | null) => void;
  close: () => void;
  setBase: (side: CompareSide | null) => void;
  setRevision: (side: CompareSide | null) => void;
  swap: () => void;
  setMode: (mode: CompareMode) => void;
  updateSettings: (patch: Partial<CompareSettings>) => void;
  setOverlayColors: (patch: Partial<OverlayColors>) => void;
  run: (runner: RunCompare) => Promise<void>;
  selectRegion: (id: number | null) => void;
  nextRegion: () => void;
  prevRegion: () => void;
  toggleReviewed: (id: number) => void;
  setSyncViews: (sync: boolean) => void;
  setLayerVisibility: (patch: Partial<{ base: boolean; revision: boolean }>) => void;
  setLayerOpacity: (patch: Partial<{ base: number; revision: number }>) => void;
}

let controller: AbortController | null = null;

function abortCurrent(): void {
  controller?.abort();
  controller = null;
}

function isAbort(e: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError")
  );
}

const initial = () => ({
  active: false,
  buildingId: null as string | null,
  base: null as CompareSide | null,
  revision: null as CompareSide | null,
  resultSides: null as CompareState["resultSides"],
  mode: "side-by-side" as CompareMode,
  settings: DEFAULT_COMPARE_SETTINGS,
  overlayColors: DEFAULT_OVERLAY_COLORS,
  status: "idle" as CompareStatus,
  progress: null as CompareProgress | null,
  result: null as CompareResult | null,
  error: null as string | null,
  selectedRegionId: null as number | null,
  focusNonce: 0,
  reviewed: [] as number[],
  syncViews: true,
  layerVisibility: { base: true, revision: true },
  layerOpacity: { base: 1, revision: 1 },
});

export const useCompareStore = create<CompareState>((set, get) => ({
  ...initial(),

  open: (prefill, buildingId) => {
    const s = get();
    const bid = buildingId !== undefined ? buildingId : s.buildingId;
    if (prefill) {
      abortCurrent();
      set({
        active: true,
        buildingId: bid,
        base: prefill.base,
        revision: prefill.revision,
        result: null,
        resultSides: null,
        status: "idle",
        progress: null,
        error: null,
        selectedRegionId: null,
        reviewed: [],
      });
    } else if (!s.active) {
      set({ active: true, buildingId: bid });
    }
  },

  close: () => {
    abortCurrent();
    set(initial());
    // Free the cached rasters (tens of MB) once compare mode is left.
    void import("./engine/rasterCache").then((m) => m.clearRasterCaches()).catch(() => {});
  },

  setBase: (base) => set({ base }),
  setRevision: (revision) => set({ revision }),
  swap: () => set((s) => ({ base: s.revision, revision: s.base })),
  setMode: (mode) => set({ mode }),
  updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  setOverlayColors: (patch) => set((s) => ({ overlayColors: { ...s.overlayColors, ...patch } })),

  run: async (runner) => {
    const { base, revision, settings } = get();
    if (!base || !revision) return;
    abortCurrent();
    const c = new AbortController();
    controller = c;
    set({ status: "running", progress: null, error: null });
    try {
      const result = await runner(base, revision, settings, {
        signal: c.signal,
        onProgress: (p) => {
          if (controller === c) set({ progress: p });
        },
      });
      if (controller !== c) return;
      controller = null;
      set({
        status: "done",
        result,
        resultSides: { base, revision },
        progress: null,
        selectedRegionId: null,
        reviewed: [],
      });
    } catch (e) {
      if (controller !== c) return;
      controller = null;
      if (isAbort(e, c.signal)) {
        set({ status: "idle", progress: null });
        return;
      }
      set({
        status: "error",
        progress: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  selectRegion: (selectedRegionId) =>
    set((s) => ({ selectedRegionId, focusNonce: s.focusNonce + 1 })),

  nextRegion: () => stepRegion(get, set, 1),
  prevRegion: () => stepRegion(get, set, -1),

  toggleReviewed: (id) =>
    set((s) => ({
      reviewed: s.reviewed.includes(id) ? s.reviewed.filter((r) => r !== id) : [...s.reviewed, id],
    })),

  setSyncViews: (syncViews) => set({ syncViews }),
  setLayerVisibility: (patch) => set((s) => ({ layerVisibility: { ...s.layerVisibility, ...patch } })),
  setLayerOpacity: (patch) => set((s) => ({ layerOpacity: { ...s.layerOpacity, ...patch } })),
}));

function stepRegion(
  get: () => CompareState,
  set: (p: Partial<CompareState>) => void,
  dir: 1 | -1,
): void {
  const { result, selectedRegionId } = get();
  const regions = result?.regions ?? [];
  if (regions.length === 0) return;
  const idx = regions.findIndex((r) => r.id === selectedRegionId);
  let next: number;
  if (idx < 0) next = dir === 1 ? 0 : regions.length - 1;
  else next = (idx + dir + regions.length) % regions.length;
  set({ selectedRegionId: regions[next]!.id, focusNonce: get().focusNonce + 1 });
}
