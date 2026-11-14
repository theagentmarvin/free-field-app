// apps/models/src/NavPanel.tsx
//
// Wave 35 (toolbar-nav redesign) — THE ONE floating panel slot.
//
// Every tenant of the Models chrome opens into this single
// rectangle (320px wide, min(500px, calc(100% - 120px)) tall, top
// 66px / left 14px):
//
//   "models"  → Models & Levels (model visibility + levels)
//   "filters" → the custom filter tree
//   "tasks"   → the building's tasks
//   "props"   → Properties (opened by SELECTING an element)
//
// Rules that this component owns:
//   - The shell NEVER remounts on a tenant swap — only the body
//     changes. That keeps the scroll position honest and avoids the
//     flicker a remount would cause.
//   - Properties is CONDITIONAL SLOT CONTENT, not a conditional
//     component mount: <PropertiesDrawer> stays mounted for the whole
//     session (it renders nothing while there is no selection) so its
//     `setOnElementPick` subscription is installed exactly once.
//   - Escape closes the slot (and clears the selection).
//   - On phones the slot becomes a bottom sheet (100% wide, ≤46dvh).
//
// The selection → Properties sync also lives here: picking an element
// sets `activeNavPanel = "props"`; deselecting clears it.
//
// Wave 39: the frosted rectangle + header + close + Escape are now
// the generic <FrostedNavSlot> shell from @ff/viewer-tools — same
// geometry, same testids, ZERO behavior change. This file only owns
// the tenant BODIES and the selection→Properties sync.

import { useCallback, useEffect, type RefObject } from "react";

import {
  CustomFiltersPanel,
  FrostedNavSlot,
  ModelsLevelsPanel,
  PropertiesDrawer,
  useIsMobile,
  useModelsToolStore,
  type NavPanelId,
} from "@ff/viewer-tools";
import type { IfcViewerHandle } from "@ff/viewer-react";

import TasksPanelBody from "./TasksPanelBody";

const PANEL_TITLES: Record<NavPanelId, string> = {
  models: "Models & Levels",
  filters: "Filters",
  tasks: "Tasks",
  props: "Properties",
};

export interface NavPanelProps {
  /** Active building id — scopes the models / levels / filters. */
  buildingId: string | null;
  /** Handle to the 3D viewer (element pick + level plans). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Open the task detail sheet for a task id (wave 50 task menu). */
  onOpenTask?: (taskId: string) => void;
}

export default function NavPanel({
  buildingId,
  viewerRef,
  onOpenTask,
}: NavPanelProps): JSX.Element {
  const activePanel = useModelsToolStore((s) => s.activeNavPanel);
  const selection = useModelsToolStore((s) => s.selection);
  const activeStoreyName = useModelsToolStore((s) => s.activeStoreyName);
  const isMobile = useIsMobile();

  const open = activePanel !== null;

  // ── Selection → Properties sync ────────────────────────────────────
  // A pick opens the slot with the Properties body; a deselect closes
  // it again. Deliberately keyed on the SELECTION only — opening a
  // nav panel while an element is selected must NOT be undone by
  // this effect (the selection didn't change).
  useEffect(() => {
    const store = useModelsToolStore.getState();
    if (selection !== null) {
      if (store.activeNavPanel !== "props") store.setActiveNavPanel("props");
      return;
    }
    if (store.activeNavPanel === "props") store.setActiveNavPanel(null);
  }, [selection]);

  // Escape close now lives in <FrostedNavSlot> (it calls `onClose`,
  // which clears the panel AND the selection).

  // ── Open a level plan from the Models & Levels body ───────────────
  const onOpenLevel = useCallback(
    (levelName: string) => {
      const h = viewerRef.current;
      if (!h) return;
      void h.openLevel(levelName);
    },
    [viewerRef],
  );

  const onClose = useCallback(() => {
    const store = useModelsToolStore.getState();
    store.setActiveNavPanel(null);
    store.clearSelection();
  }, []);

  return (
    <FrostedNavSlot
      open={open}
      title={activePanel ? PANEL_TITLES[activePanel] : ""}
      onClose={onClose}
      mobile={isMobile}
      dataPanel={activePanel ?? "none"}
    >
      {activePanel === "models" && (
        <ModelsLevelsPanel
          buildingId={buildingId}
          onOpenLevel={onOpenLevel}
          activeLevelName={activeStoreyName}
        />
      )}
      {activePanel === "filters" && (
        <CustomFiltersPanel buildingId={buildingId} />
      )}
      {activePanel === "tasks" && (
        <TasksPanelBody
          viewerRef={viewerRef}
          storeyName={activeStoreyName}
          onOpenTask={onOpenTask}
        />
      )}
      {/* Properties is ALWAYS MOUNTED (see the file header): the
          `setOnElementPick` subscription must survive every tenant
          swap. It renders nothing while there is no selection. */}
      <div
        style={{ display: activePanel === "props" ? "block" : "none" }}
        data-testid="nav-panel-properties"
      >
        <PropertiesDrawer viewerRef={viewerRef} variant="body" />
      </div>
    </FrostedNavSlot>
  );
}