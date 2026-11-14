// @ff/viewer — headless 3D viewer core.
//
// Exports the OBC / PDF primitives consumed by both the React
// shell (@ff/viewer-react) and any future non-React consumer
// (e.g. a Vue or Solid adapter in Phase 1+).
//
// No React, no DOM, no app-specific state. The CSS side-effect
// import for pdfViewer.css lives in @ff/viewer-react/src/index.ts
// — keep this entry point DOM-free so non-React consumers don't
// pay the cost.

export { createLevelPlanController } from "./level/LevelPlanController";
export { LEVEL_PLAN_FRAME_DISTANCE } from "./level/LevelPlanController";
export type { LevelPlanHandle } from "./level/LevelPlanController";
export {
  MeasurementLineSystem,
  measureLineMachine,
  type MeasureLineState,
  type MeasureLineEvent,
} from "./level/MeasurementLineSystem";
export {
  SegmentLabels,
  formatPlanDistance,
  planDistance,
  type MeasureLabelFactory,
  type MeasureMarkHandle,
  type PlanUnits,
  type PlanLengthUnit,
} from "./level/measureLabels";
export { loadPDF, validatePDFBuffer, MAX_PDF_SIZE } from "./pdf/loadPdf";
export type { PdfApi } from "./pdf/loadPdf";
export { PdfViewer } from "./pdf/pdfViewer";
export type { ScaleEvent } from "./pdf/pdfViewer";
export { computeSnapshotCrop, SNAPSHOT_CROP_FRACTION } from "./pdf/pdfSnapshot";
export type { SnapshotCrop } from "./pdf/pdfSnapshot";
