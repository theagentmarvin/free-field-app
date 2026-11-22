// Wave 14 — picking backend seam (barrel).
//
// Pure, drift-clean modules: no three.js import anywhere in this
// directory. Re-exported for IfcViewer and for the focused unit tests.

export type { BackendId, NdcPoint, WorldPoint } from "./pickTypes";
export { chooseBackend, isRaycastPrimary } from "./chooseBackend";
export type { BackendProbe } from "./chooseBackend";
export {
  isBenchEnabled,
  percentile,
  computePickStats,
  formatPickStats,
} from "./pickBench";
export type { PickStats } from "./pickBench";
export {
  detectIdPassInterop,
  raceLocalId,
  LOCAL_ID_BUDGET_MS,
} from "./idPassInterop";
export type { IdPassOptions } from "./idPassInterop";
export type {
  IdItem,
  BatchedIdPassReader,
  BatchedReadOutcome,
  BatchedReadStats,
  IdPassInterop,
} from "./idPassInterop";
export {
  resolveDebugToolsEnabled,
  isDebugToolsEnabled,
  buildDebugToolsSurface,
  DEBUG_TOOLS_PARAM,
  DEBUG_TOOLS_STORAGE_KEY,
  resolveScissorOverride,
  isRenderScissorEnabled,
} from "./debugTools";
export type {
  DebugToolsContext,
  DebugToolsSurface,
} from "./debugTools";
export {
  pickAnchorClipped,
  anchorClipMode,
} from "./anchorScissor";
export type { AnchorResult } from "./anchorScissor";
export {
  toWorldPoint,
  pickWorldPointFast,
  pickWorldPointRaycast,
  pickElementFast,
  pickElementFastTolerant,
  pickElementIdFastTolerant,
  pickElementIdRaycast,
  pickElementIdRaycastFirst,
  mapRaycastHit,
  RAYCAST_PICK_TIMEOUT_MS,
  withStallGuard,
  PICK_STALL_BUDGET_MS,
  idPassProbes,
  mapFullPick,
  normalizePickHit,
  resolveNearestHit,
} from "./pickSeam";
export type {
  FastPointPicker,
  FastElementPicker,
  WorldPointCaster,
  ElementProbe,
  FullPickLike,
  ElementPickLike,
  IdPickHit,
  RawPickHit,
  RaycasterHitLike,
  RaycastResultLike,
  WorkerRaycaster,
  RaycastIdHit,
  RaycastFirstResult,
  RaycastFirstDeps,
} from "./pickSeam";export { HiddenElementTracker, filterHiddenHit } from "./hiddenFilter";
