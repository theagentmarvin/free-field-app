// apps/documents/src/documentsViewState.ts
//
// Wave 63 — tiny shared flag: "Documents has a PDF open". A mounted
// <PdfOverlay> is opaque and full-bleed, so the shared 3D surface
// underneath (wave 56) draws frames nobody can see. The settings
// shell's <ViewerKeepAlive> reads this flag to pause that rendering.

import { create } from "zustand";

interface DocumentsViewState {
  pdfOpen: boolean;
  setPdfOpen: (open: boolean) => void;
}

export const useDocumentsViewState = create<DocumentsViewState>((set) => ({
  pdfOpen: false,
  setPdfOpen: (open) => set((s) => (s.pdfOpen === open ? s : { pdfOpen: open })),
}));
