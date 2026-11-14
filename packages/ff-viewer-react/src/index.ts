// @ff/viewer-react — React shell for the FreeField viewer.
//
// Re-exports the three React pieces that any consumer (Settings,
// Models, hybrid) needs:
//
//   - <IfcViewer>          → 3D viewport (OBC world, FragmentsManager)
//   - <ViewerHandleProvider> / useViewerHandle() → imperative handle
//   - <PdfOverlay>         → PDF.js canvas overlay
//
// CSS for <PdfOverlay> lives in @ff/viewer/src/pdf/pdfViewer.css.
// Consumers that mount <PdfOverlay> must import that CSS file
// explicitly in their app entry point — we intentionally do NOT
// auto-import it here because cross-package CSS imports via
// `exports` map subpaths are brittle under Vite/Vitest resolution.
// Example consumer entry:
//
//   import "@ff/viewer/src/pdf/pdfViewer.css";  // ← explicit, stable
//   import { MainAppChrome } from "./main-app/MainAppChrome";

// Named export is the only public API. The historical default
// export pattern (`import IfcViewer from "@viewer/IfcViewer"`) is
// gone — all consumers should use `import { IfcViewer } from
// "@ff/viewer-react"`. The named form is clearer about where
// the component comes from, matches the pattern of every other
// React component in the codebase, and keeps the barrel's
// exports map from growing in lockstep with the internal
// default-export-as-named re-export dance.
export { IfcViewer } from "./IfcViewer";
export type {
  IfcViewerProps,
  IfcViewerHandle,
  IfcViewerSlice,
  IfcFileListItem,
  StoreyMeta,
  ViewerPose,
  MeasureVariant,
  MeasureMode,
  MeasureReadout,
  MeasurementEntry,
  SectionPlaneData,
  MotionSpeedupsConfig,
  RenderOnDemandConfig,
  SplitTileBuildConfig,
  TileCacheConfig,
} from "./IfcViewer";
export type { RenderSchedulerStats } from "./perf/renderScheduler";
export { MAX_SECTION_PLANES } from "./IfcViewer";
export { ModelUnloadedError, isModelUnloadedError } from "./modelUnloadedError";

// Wave 67: pure measurement display helpers (no engine imports at call time).
export {
  formatMeasureValue,
  unitSymbol,
  MEASURE_VARIANT_LABELS,
} from "./measure/measureFormat";

// Task 22: flattenItemData is a pure helper (no React/TOE
// dependencies) — re-export it from its own module so tests
// can import it WITHOUT triggering IfcViewer.tsx's heavy
// module load (OBC + Three.js + Stats.js). IfcViewer.tsx also
// imports it internally.
export { flattenItemData, getPropertyGroups } from "./flattenItemData";
export type { IfcItemData, PropertyGroup } from "./flattenItemData";

// Task 23: in-memory inverted index for fast custom-filter
// evaluation. Pure module — same rationale as flattenItemData.
// Consumers in `apps/models` import `buildInvertedIndex`,
// `evaluateRule`, and the type re-exports.
export {
  buildInvertedIndex,
  evaluateRule,
} from "./indexPropertyData";
export type {
  PropertyDataRow,
  InvertedIndex,
  IndexFilterRule,
} from "./indexPropertyData";

export {
  ViewerHandleProvider,
  useViewerHandle,
  ViewerHandleContext,
} from "./ViewerHandleContext";

export { default as PdfOverlay } from "./pdf/PdfOverlay";
export type { PdfOverlayProps, PdfOverlayHandle } from "./pdf/PdfOverlay";
