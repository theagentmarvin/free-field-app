// packages/ff-viewer-tools/src/index.ts
//
// Public API barrel for @ff/viewer-tools.
//
// This package provides reusable viewer *capabilities* — selection,
// filtering, and property inspection — for any FreeField module that
// mounts an <IfcViewer> (Models today, LinkView in Stage 2). It is
// intentionally Dexie-free and app-schema-free:
//
//   - The 3D scene is consumed via @ff/viewer-react's imperative
//     `IfcViewerHandle` (threaded in as a `viewerRef`).
//   - Persisted/queryable data is consumed via the injected
//     `ViewerToolsDataSource` (see dataSource.ts). Wrap the module
//     subtree in <ViewerToolsProvider dataSource={...}> once.
//
// Consumers should import ONLY from this barrel, never from deep
// package paths — that keeps the internal file layout free to change.

// ── Dependency-injection boundary ────────────────────────────────
export {
  ViewerToolsProvider,
  useViewerToolsDataSource,
} from "./dataSource";
export type {
  ViewerToolsDataSource,
  ViewerToolsProviderProps,
  AutoFilterEntry,
  PropertyCatalogEntryLite,
  StoreyLite,
} from "./dataSource";

// ── Shared app-wide store (relocated as-is; shared by construction)
export {
  useModelsToolStore,
  loadPersistedAutoExpanded,
  persistAutoExpanded,
} from "./modelsToolStore";
export type {
  ModelsToolState,
  SelectedElement,
  FilterEntryId,
  FilterGroupId,
  AutoFilterGroupState,
  FilterState,
  FilterOperator,
  FilterRule,
  ConditionGroup,
  FilterPreset,
  Combinator,
  NavPanelId,
} from "./modelsToolStore";

// ── Property index store (in-memory inverted index) ──────────────
export { usePropertyIndexStore } from "./propertyIndexStore";

// ── Manual-visibility overlay store (Wave 48 context toolbar) ──
export {
  useManualVisibilityStore,
  computeFinalVisibleSets,
} from "./manualVisibilityStore";
export type {
  ManualIsolate,
  ManualVisibilityState,
  ManualVisibilityStore,
  ManualVisibilityOverlay,
} from "./manualVisibilityStore";

// ── Components (mounted by the host module's chrome) ─────────────
export { default as FiltersPanel } from "./components/FiltersPanel";
export type { FiltersPanelProps } from "./components/FiltersPanel";
export { default as ModelsLevelsPanel } from "./components/ModelsLevelsPanel";
export type { ModelsLevelsPanelProps } from "./components/ModelsLevelsPanel";
export { default as CustomFiltersPanel } from "./components/CustomFiltersPanel";
export type { CustomFiltersPanelProps } from "./components/CustomFiltersPanel";
export { default as VisibilitySwitch } from "./components/VisibilitySwitch";
export type { VisibilitySwitchProps } from "./components/VisibilitySwitch";
export { default as PropertiesDrawer } from "./components/PropertiesDrawer";
export type { PropertiesDrawerProps } from "./components/PropertiesDrawer";
export { default as FloorPlanToggle } from "./components/FloorPlanToggle";
export type {
  FloorPlanToggleProps,
  RightViewerMode,
} from "./components/FloorPlanToggle";

// ── Mobile layout primitives (Task 36) ────────────────────────────
export { useIsMobile, DEFAULT_MOBILE_MAX_WIDTH } from "./hooks/useIsMobile";
export { default as MobileStack } from "./components/MobileStack";
export type { MobileStackProps } from "./components/MobileStack";

// ── Generic frosted navigation shell (wave 39) ─────────────────────
export { FrostedNavToolbar, FrostedNavSlot } from "./components/FrostedNav";
export type {
  FrostedNavButton,
  FrostedNavToolbarProps,
  FrostedNavSlotProps,
} from "./components/FrostedNav";

// ── Documents panel tenant store (wave 39) ─────────────────────────
export { useDocumentsToolStore } from "./documentsToolStore";
export type { DocumentsToolState, DocsPanelId } from "./documentsToolStore";

// ── Pipeline hooks (take a viewerRef → applied per-viewer) ───────
export { useViewerExpressIdMaps } from "./hooks/useViewerExpressIdMaps";
export { useModelsToolFilter } from "./hooks/useModelsToolFilter";
export type { UseModelsToolFilterResult } from "./hooks/useModelsToolFilter";
export { useViewerSelectionSync } from "./hooks/useViewerSelectionSync";
export { useViewerHandle, createObservableRef } from "./hooks/useViewerHandle";
export type { ObservableRef } from "./hooks/useViewerHandle";
export { useFloorPlanOverlay, computeOverlayPlacement } from "./hooks/useFloorPlanOverlay";
export type {
  FloorPlanOverlayState,
} from "./hooks/useFloorPlanOverlay";

// ── Data / filter hooks (consume the injected data source) ───────
export { usePropertyCatalog } from "./hooks/usePropertyCatalog";
export type { PropertyCatalogCache } from "./hooks/usePropertyCatalog";
export { useFilterPresetsForBuilding } from "./hooks/useFilterPresetsForBuilding";
export type { UseFilterPresetsForBuildingResult } from "./hooks/useFilterPresetsForBuilding";

// ── Filter resolution (pure) ─────────────────────────────────────
export { computeMatchingExpressIds } from "./hooks/filterResolution";
export type { ModelsToolFilters } from "./hooks/filterResolution";

// Shared bottom-centre floating bar (Models toolbar + Documents measure bar)
export {
  FloatingBar,
  BAR_TOKENS,
  floatingBarAnchorStyle,
  barRowStyle,
  segGroupStyle,
  segButtonStyle,
  menuStyle,
  menuRowStyle,
  readoutChipStyle,
  clearButtonStyle,
} from "./components/floatingBar";
export type { FloatingBarProps } from "./components/floatingBar";
