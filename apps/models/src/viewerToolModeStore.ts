// apps/models/src/viewerToolModeStore.ts
//
// Wave 47 — tiny app-local state seam shared by the bottom
// <ViewerToolbar> (which OWNS the select/measure/section tool mode)
// and the right-click <SelectionContextToolbar> (which must SUPPRESS
// itself while a non-navigation tool is armed). The measure tool is
// also observable on `IfcViewerHandle.activeTool`, but the section
// click-to-place mode is pure <ViewerToolbar> local state — this store
// is the single place both surfaces can agree on tool state without
// promoting the shared `@ff/viewer-tools` modelsToolStore (kept
// read-only for this wave).
//
// `sectionRev` is a monotonically-increasing counter bumped whenever
// something other than <ViewerToolbar> mutates the section planes (the
// context toolbar's "Create section plane"). <ViewerToolbar> watches it
// to refresh its "n/8 cuts" readout.

import { create } from "zustand";

export type ViewerToolMode = "navigation" | "measure" | "section";

interface ViewerToolModeState {
  mode: ViewerToolMode;
  sectionRev: number;
  setMode: (mode: ViewerToolMode) => void;
  bumpSectionRev: () => void;
}

export const useViewerToolModeStore = create<ViewerToolModeState>((set) => ({
  mode: "navigation",
  sectionRev: 0,
  setMode: (mode) => set({ mode }),
  bumpSectionRev: () => set((s) => ({ sectionRev: s.sectionRev + 1 })),
}));