export * from "./logic";
export * from "./composeModel";
export * from "./snapshot";
export * from "./tasksSource";
export * from "./demoTaskSeedRunner";
export { TasksListPanel, type TasksListPanelProps } from "./TasksListPanel";
export {
  usePhotoUrl,
  resolvePhotoUrlCached,
  clearPhotoUrlCache,
  PHOTO_URL_CACHE_LIMIT,
  type PhotoUrlResolver,
} from "./usePhotoUrl";
export { useTaskPhotoResolver } from "./photoResolver";
export { TaskComposeSheet, type TaskComposeSheetProps } from "./TaskComposeSheet";
export { TasksApp, type TasksAppProps } from "./TasksApp";
export { useTaskEngine, draftTable, registerBlob, releaseBlob } from "./useTaskEngine";
export * from "./callouts";
export { useTaskPeople, type TaskPerson } from "./useTaskPeople";
export { TaskCalloutLayer3D, type TaskCalloutLayer3DProps } from "./TaskCalloutLayer3D";
export { TapCreateMarker3D, type TapCreateMarker3DProps } from "./TapCreateMarker3D";
export { TapCreateTask3D, type TapCreateTask3DProps } from "./TapCreateTask3D";
export * from "./createMarker";
export * from "./pdfPins";
export * from "./calibResolve";
export {
  TaskCalloutLayer2D,
  type TaskCalloutLayer2DProps,
} from "./TaskCalloutLayer2D";
export { TapCreateMarker2D, type TapCreateMarker2DProps } from "./TapCreateMarker2D";
export * from "./detailLogic";
export * from "./printDocument";
export * from "./formStyles";
export * from "./useOnlineStatus";
export { TaskDetailView, type TaskDetailViewProps } from "./TaskDetailView";
export { TaskDetailHost, type TaskDetailHostProps } from "./TaskDetailHost";
export { TaskActivityPopup, type TaskActivityPopupProps } from "./TaskActivityPopup";
export { TaskTimeline, type TaskTimelineProps } from "./TaskTimeline";
export { PhotoLightbox, type PhotoLightboxProps } from "./PhotoLightbox";
export { TaskOutboxSheet, type TaskOutboxSheetProps } from "./TaskOutboxSheet";
export * from "./tableColumns";
export * from "./columnFilters";
export * from "./taskListQuery";
export { TaskTablePanel, type TaskTablePanelProps } from "./TaskTablePanel";
export { TaskBoardPanel, type TaskBoardPanelProps, BOARD_COLUMNS, type BoardColumn, boardColumnFor } from "./TaskBoardPanel";
export { TaskColumnFilterPopover, type TaskColumnFilterPopoverProps } from "./TaskColumnFilterPopover";
export { TaskColumnPicker, type TaskColumnPickerProps } from "./TaskColumnPicker";
export { useIsWide } from "./useIsWide";
export * from "./panelLogic";
export { useOutboxRows, queryActiveOutboxRows } from "./useOutboxRows";
export { usePanelTasks, usePanelActorUid } from "./usePanelTasks";
export { TaskMiniPanel, type TaskMiniPanelProps, type TaskMiniPanelVariant } from "./TaskMiniPanel";
export {
  TaskToolbar,
  type TaskToolbarProps,
  ToolbarButton,
  type ToolbarButtonProps,
  ToolbarChip,
  type ToolbarChipProps,
  ToolbarSearchInput,
  type ToolbarSearchInputProps,
  ToolbarSelect,
  type ToolbarSelectProps,
  TOOLBAR_CHIPS,
} from "./TaskToolbar";
export * from "./bulkLogic";
export * from "./boardMove";
export * from "./mentions";
export * from "./exportTasks";
export * from "./capabilities";
export { TaskBulkBar, type TaskBulkBarProps } from "./TaskBulkBar";
export { TaskToast, type TaskToastProps } from "./TaskToast";
export { TaskConfirmDialog, type TaskConfirmDialogProps } from "./TaskConfirmDialog";
export { TaskShortcutsSheet } from "./TaskShortcutsSheet";
export { TaskChecklist } from "./TaskChecklist";
export { DeadlineChip, PriorityChip, ChecklistProgress } from "./TaskChips";
export { useTaskShortcuts, resolveShortcut, SHORTCUT_HELP, type ShortcutAction } from "./useTaskShortcuts";

// 2026-11-14 — building scope for viewer task pins/lists.
export {
  effectiveTaskBuildingId,
  tasksForBuilding,
  useTaskBuildingIndex,
  EMPTY_TASK_BUILDING_INDEX,
  withEffectiveBuilding,
  resolveCreateBuildingId,
} from "./taskBuilding";
export type { TaskBuildingIndex, BuildingScopedTask } from "./taskBuilding";
export { ProjectSyncMount, getWebSyncEngine, type ProjectSyncMountProps } from "./ProjectSyncMount";
export { restoreDraftCompose, type DraftBlobReader } from "./draftRestore";

// Quick access from a task's location (open the view it was created in).
export {
  requestTaskOpen,
  consumeTaskOpen,
  setTaskOpenNotice,
  setTaskHighlight,
  getTaskOpenState,
  subscribeTaskOpen,
  resetTaskOpenStore,
  useTaskOpenState,
} from "./taskOpenStore";
export type {
  TaskOpenIntent,
  TaskOpenModelsIntent,
  TaskOpenDocumentsIntent,
  TaskOpenState,
} from "./taskOpenStore";
export {
  resolveTaskTarget,
  openTaskLocation,
  useOpenTaskLocation,
  taskOpenKind,
  OPEN_LABEL,
} from "./taskTarget";
export type { TargetLookup, OpenableTask, TaskTargetResult } from "./taskTarget";
export { TaskOpenNotice } from "./TaskOpenNotice";
export { LocationThumb, OpenableLocationThumb } from "./LocationThumb";

// Project sheets attached to tasks by reference.
export { SheetChips, SheetPicker } from "./SheetAttachments";
export { useSheetCatalog, openSheetRef, loadSheetCatalog, EMPTY_SHEET_CATALOG } from "./sheetCatalog";
export {
  describeSheetRef,
  makeSheetRef,
  resolveSheetRefOpen,
  toggleSheetRef,
  buildPickerSections,
} from "./sheetRefs";
export type { SheetCatalog, SheetRefView, PickerSection, PickerEntry } from "./sheetRefs";

// BCF export (integration half; the writer lives in @ff/tasks).
export * from "./bcfExport";
export { fetchBinaryFromUrl, convertToPng } from "./bcfBrowser";
export { loadMemberEmails } from "./memberEmails";
