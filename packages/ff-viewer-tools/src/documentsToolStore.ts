// packages/ff-viewer-tools/src/documentsToolStore.ts
//
// Wave 39 — the Documents module's floating-panel tenant state.
//
// Mirrors the Models module's `modelsToolStore.activeNavPanel` seam:
// the ONE Documents panel slot holds either the `docs` tenant (the
// file/folder list) or the `outline` tenant (the PDF outline +
// thumbnails), or is closed (`null`).
//
// Kept in @ff/viewer-tools (next to modelsToolStore) so it is the
// same store-shaped zustand slice the Models chrome uses, and so a
// future deep consumer can read the active Documents panel without
// importing apps/documents.

import { create } from "zustand";

/** The tenants of the ONE Documents floating panel slot. */
export type DocsPanelId = "docs" | "outline";

export interface DocumentsToolState {
  /**
   * Which tenant owns the Documents panel slot. `null` = closed.
   * The documents module is expected to default this to `"docs"`
   * on mount (mirrors today's always-visible sidebar).
   */
  activeDocsPanel: DocsPanelId | null;
  setActiveDocsPanel: (panel: DocsPanelId | null) => void;
}

export const useDocumentsToolStore = create<DocumentsToolState>((set) => ({
  activeDocsPanel: "docs",
  setActiveDocsPanel: (panel) => set({ activeDocsPanel: panel }),
}));