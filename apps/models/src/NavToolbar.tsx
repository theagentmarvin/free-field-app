// apps/models/src/NavToolbar.tsx
//
// Wave 35 (toolbar-nav redesign) — the top-left navigation toolbar.
//
// A FLOATING, ICON-ONLY, segmented pill anchored at the top-left of
// the canvas (14px inset). Exactly three buttons:
//
//   ▣  Models & Levels   → the Models + Levels panel
//   ▽  Filters           → the custom filter tree
//   ☑  Tasks             → the task list
//
// No text labels — the native `title` tooltip carries the name and
// the raised white segment carries the state (iOS segmented-control
// pattern).
//
// Toggle behaviour (spec §3):
//   - inactive button  → open its panel
//   - active button    → close it
//   - another button   → swap the content in place (the panel shell
//                        stays mounted — no flicker, no remount)
//   - Escape           → close (handled by <NavPanel>)
//
// Phone (<768px): the pill row scrolls horizontally and spans the
// available width.
//
// Wave 39: this is now a thin wrapper over the generic
// <FrostedNavToolbar> shell in @ff/viewer-tools — same geometry,
// same testids, ZERO behavior change.

import {
  FrostedNavToolbar,
  useIsMobile,
  useModelsToolStore,
  type FrostedNavButton,
  type NavPanelId,
} from "@ff/viewer-tools";
import { usePanelTasks } from "@ff/tasks-react";

/** The three tenants of the ONE floating panel slot. */
type NavButton = Omit<FrostedNavButton, "id"> & {
  id: Exclude<NavPanelId, "props">;
};

const NAV_BUTTONS: NavButton[] = [
  {
    id: "models",
    label: "Models & Levels",
    path: "M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2zM4 11l8 4.5 8-4.5",
  },
  {
    id: "filters",
    label: "Filters",
    path: "M3 5h18l-7 8v5l-4 2v-7L3 5z",
  },
  {
    id: "tasks",
    label: "Tasks",
    path: "M3 5l2 2 4-4M3 13l2 2 4-4M13 6h8M13 14h8",
  },
];

export default function NavToolbar(): JSX.Element {
  const activePanel = useModelsToolStore((s) => s.activeNavPanel);
  const setActiveNavPanel = useModelsToolStore((s) => s.setActiveNavPanel);
  const isMobile = useIsMobile();
  // Wave 40 — the open-task count rides as a badge on the Tasks
  // button (the floating bottom-left "N tasks" pill is gone).
  // 2026-11-14 — counted for the ACTIVE building only.
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const panelTasks = usePanelTasks({ buildingId: activeBuildingId });

  function onToggle(id: string): void {
    // Active → close. Anything else → open / swap in place.
    setActiveNavPanel(activePanel === id ? null : (id as NavPanelId));
  }

  return (
    <FrostedNavToolbar
      buttons={NAV_BUTTONS}
      activeId={activePanel}
      onToggle={onToggle}
      mobile={isMobile}
      badges={{ tasks: panelTasks.length }}
      ariaLabel="Models navigation"
      testId="nav-toolbar"
    />
  );
}