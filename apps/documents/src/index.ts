// @free-field/documents — Documents module barrel.
//
// Public surface:
//   - <DocumentsApp>  → route entry for `/documents`. Phase A ships a
//                       placeholder that proves the route + Vite alias
//                       wiring work. Phase B layers on the data hooks
//                       (useDocFiles, useDocFolders, useDocPipeline);
//                       Phase C adds the sidebar + viewer shell.
//
// What's NOT exported yet:
//   - <DocumentsSidebar>, <DocumentsViewerPanel>. Implementation
//     details; will be re-exported here when Phase C lands.
//
// Usage from @free-field/settings:
//
//   import { DocumentsApp } from "@free-field/documents";
//   <Route path="/documents" element={<DocumentsApp />} />
//
// The runtime is single-origin: both modules are bundled by
// @free-field/settings's Vite. They share the same `db` singleton
// imported from @ff/data/db/database, which means updates in the
// Settings module (PDF uploads, building creation) are visible to
// the Documents module via Dexie's live-query hooks on the next tick.
export { default as DocumentsApp } from "./DocumentsApp";
// Wave 63 — "a PDF covers the 3D surface" flag for the settings shell.
export { useDocumentsViewState } from "./documentsViewState";
