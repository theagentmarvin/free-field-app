// apps/documents/src/sheetData/sheetDataStore.ts
//
// Shared state of the "drawing data" feature: the open sheet's payload and the
// current selection (one element, or every instance of a category). The tap
// layer writes it; the Properties / Elements / Schedules panels of the floating
// toolbar and the highlight read it.

import { create } from "zustand";

import { UNCATEGORISED } from "./elementRows";
import type { SheetPayload } from "./sheetPayload";

export interface SheetDataState {
  /** undefined = loading, null = this PDF has no sheet data. */
  payload: SheetPayload | null | undefined;
  /** GlobalIds currently selected on the drawing (highlighted). */
  selectedGids: string[];
  /** Set when the selection came from a category (all its instances). */
  selectedCategory: string | null;
  setPayload: (payload: SheetPayload | null | undefined) => void;
  selectElement: (gid: string) => void;
  /** Select (and highlight) every instance of `category`; selecting it again clears. */
  selectCategory: (category: string) => void;
  clearSelection: () => void;
}

/** Distinct GlobalIds of the elements of a category on the sheet. */
export function gidsOfCategory(payload: SheetPayload, category: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of payload.elements) {
    if (seen.has(e.gid)) continue;
    const c = payload.elementRecords[e.gid]?.category?.trim() || UNCATEGORISED;
    if (c === category) {
      seen.add(e.gid);
      out.push(e.gid);
    }
  }
  return out;
}

export const useSheetDataStore = create<SheetDataState>((set, get) => ({
  payload: undefined,
  selectedGids: [],
  selectedCategory: null,
  setPayload: (payload) => set({ payload }),
  selectElement: (gid) => set({ selectedGids: [gid], selectedCategory: null }),
  selectCategory: (category) => {
    const { payload, selectedCategory } = get();
    if (!payload) return;
    if (selectedCategory === category) {
      set({ selectedGids: [], selectedCategory: null });
      return;
    }
    set({ selectedGids: gidsOfCategory(payload, category), selectedCategory: category });
  },
  clearSelection: () => set({ selectedGids: [], selectedCategory: null }),
}));
