// @free-field/models — Models module barrel.
//
// Public surface:
//   - <ModelsApp>        → route entry. Wraps the chrome + viewer in
//                          <ViewerHandleProvider> and auto-selects the
//                          first building from Dexie.
//   - <BuildingPicker>   → read-only building dropdown (listbox).
//                          Reused by the Documents module's per-
//                          building sidebar (Task 20F wire-up).
//   - <BuildingSwitcher> → the wave-35 module-rail dropdown: the same
//                          live-query content, opened to the right of
//                          the 64px rail by the app shell.
//   - useModelsToolStore → Zustand store for the active nav panel,
//                          the active building, hydration, and the
//                          future active storey name.
//                          Exposed in case a sibling module (Settings
//                          via dev tools, a future Filters panel) needs
//                          to read models UI state.
//
// What's NOT exported:
//   - <Viewer>, <MainAppChrome>, <NavToolbar>, <NavPanel>.
//     They're implementation details of <ModelsApp> and may be
//     reorganized without affecting the public API.
//   - The hydration hook. It's an implementation detail of ModelsApp.
//
// Usage from @free-field/settings:
//
//   import { ModelsApp } from "@free-field/models";
//   <Route path="/models" element={<ModelsApp />} />
//
// The runtime is single-origin: both modules are bundled by
// @free-field/settings's Vite. They share the same `db` singleton
// imported from @ff/data/db/database, which means updates in the
// Settings module (uploads, mappings) are visible to the Models
// module via Dexie's live-query hooks on the next tick.
export { default as ModelsApp } from "./ModelsApp";
export type { ModelsAppProps } from "./ModelsApp";
export { default as PersistentViewerSurface } from "./PersistentViewerSurface";
export type { PersistentViewerSurfaceProps } from "./PersistentViewerSurface";
export {
  ViewerSurfaceHostContext,
  useViewerSurfaceHost,
  ViewerSurfaceHostSlot,
} from "./viewerSurfaceHost";
export type {
  ViewerSurfaceHostValue,
  ViewerSurfaceHostSlotProps,
} from "./viewerSurfaceHost";
export { default as BuildingPicker } from "./BuildingPicker";
export type { BuildingPickerProps } from "./BuildingPicker";
export {
  BuildingSwitcher,
  BuildingIcon,
  useActiveBuilding,
  useBuildingOptions,
} from "./BuildingPicker";
export type { BuildingSwitcherProps } from "./BuildingPicker";
export { useModelsToolStore } from "@ff/viewer-tools";
export type { ModelsToolState } from "@ff/viewer-tools";

// Wave 56 — the Dexie-backed ViewerToolsDataSource the Models module
// (and now the Documents route's mapping toolbar) injects. Reused
// as-is rather than forked: it is building-scoped and app-agnostic.
export { modelsDataSource } from "./modelsDataSource";
export type { ViewerToolsDataSource } from "@ff/viewer-tools";
