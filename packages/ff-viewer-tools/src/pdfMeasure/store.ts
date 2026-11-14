// Measure tool state: tool + in-progress draft + committed measurements.
// Measurements are stored in PAGE units, keyed per PDF version + page, so
// they survive page flips and re-scaling (labels recompute). Held in a
// module-level zustand store, so they outlive the component for the whole
// session. No Dexie.

import { create } from "zustand";

import { distance, type Point } from "./geometry";

export type MeasureTool = "none" | "length" | "area" | "scale";

export interface Measurement {
  id: string;
  kind: "length" | "area";
  points: Point[];
}

export function measureKey(pdfVersionId: string, page: number): string {
  return `${pdfVersionId}#${page}`;
}

export const MIN_POINTS = { length: 2, area: 3 } as const;

const SCALES_LS_KEY = "ff-pdf-measure-scales";

function loadScales(): Record<string, number> {
  try {
    const raw = globalThis.localStorage?.getItem(SCALES_LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveScales(s: Record<string, number>): void {
  try {
    globalThis.localStorage?.setItem(SCALES_LS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: session-only */
  }
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `m${Date.now().toString(36)}${seq}`;
}

export interface PdfMeasureState {
  tool: MeasureTool;
  draft: Point[];
  measurements: Record<string, Measurement[]>;
  /** user-set metres per page unit, per page key */
  manualScales: Record<string, number>;

  setTool(tool: MeasureTool): void;
  /** Add a draft point; ignores a point within `minGap` of the last one (double-click). */
  addDraftPoint(p: Point, minGap?: number): void;
  removeLastDraftPoint(): void;
  /** Escape: drop the draft; with no draft, deactivate the tool. */
  cancel(): void;
  /** Commit the draft as a measurement. Returns false if too few points. */
  finish(key: string): boolean;
  remove(key: string, id: string): void;
  clearPage(key: string): void;
  setManualScale(key: string, metresPerUnit: number | null): void;
}

export const usePdfMeasureStore = create<PdfMeasureState>((set, get) => ({
  tool: "none",
  draft: [],
  measurements: {},
  manualScales: loadScales(),

  setTool(tool) {
    set({ tool, draft: [] });
  },

  addDraftPoint(p, minGap = 0) {
    const { draft, tool } = get();
    if (tool === "none") return;
    if (tool === "scale" && draft.length >= 2) return;
    const last = draft[draft.length - 1];
    if (last && distance(last, p) <= minGap) return;
    set({ draft: [...draft, p] });
  },

  removeLastDraftPoint() {
    set((s) => ({ draft: s.draft.slice(0, -1) }));
  },

  cancel() {
    set((s) => (s.draft.length > 0 ? { draft: [] } : { tool: "none" }));
  },

  finish(key) {
    const { tool, draft } = get();
    if (tool !== "length" && tool !== "area") return false;
    if (draft.length < MIN_POINTS[tool]) return false;
    const m: Measurement = { id: newId(), kind: tool, points: draft };
    set((s) => ({
      draft: [],
      measurements: { ...s.measurements, [key]: [...(s.measurements[key] ?? []), m] },
    }));
    return true;
  },

  remove(key, id) {
    set((s) => ({
      measurements: {
        ...s.measurements,
        [key]: (s.measurements[key] ?? []).filter((m) => m.id !== id),
      },
    }));
  },

  clearPage(key) {
    set((s) => ({ measurements: { ...s.measurements, [key]: [] } }));
  },

  setManualScale(key, metresPerUnit) {
    set((s) => {
      const next = { ...s.manualScales };
      if (metresPerUnit && metresPerUnit > 0) next[key] = metresPerUnit;
      else delete next[key];
      saveScales(next);
      return { manualScales: next, draft: [], tool: s.tool === "scale" ? "none" : s.tool };
    });
  },
}));
