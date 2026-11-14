// packages/ff-viewer-tools/src/components/ModelsLevelsPanel.tsx
//
// Wave 35 (toolbar-nav redesign) — the "Models & Levels" BODY of the
// one floating nav panel.
//
// It is today's "Auto (managed)" section promoted to a panel tenant:
// two stacked groups — MODELS (the building's IFC files, with their
// visibility switches) then LEVELS (the storeys, with their
// visibility switches + an "open this level" action).
//
// The store wiring lives in `useAutoFiltersController` so this body
// and the legacy <FiltersPanel> orchestrator can never drift apart.

import AutoFilterSection from "./AutoFilterSection";
import { useAutoFiltersController } from "./useFiltersPanelController";

export interface ModelsLevelsPanelProps {
  /**
   * Active building id. `null` while the user hasn't picked one yet.
   */
  buildingId: string | null;
  /**
   * Called when the user activates a LEVEL row. The host opens the
   * level plan on the viewer (`viewerRef.openLevel(name)`).
   */
  onOpenLevel?: (levelName: string) => void;
  /** Name of the currently open level (drives the "open" badge). */
  activeLevelName?: string | null;
}

export default function ModelsLevelsPanel({
  buildingId,
  onOpenLevel,
  activeLevelName = null,
}: ModelsLevelsPanelProps): JSX.Element {
  const auto = useAutoFiltersController(buildingId);

  return (
    <div data-testid="models-levels-panel" aria-label="Models & Levels">
      <AutoFilterSection
        models={auto.models}
        levels={auto.levels}
        filters={auto.auto}
        onToggleActive={auto.onToggleActive}
        onToggleHidden={auto.onToggleHidden}
        onToggleExpanded={auto.onToggleExpanded}
        showSectionHeader={false}
        onOpenLevel={onOpenLevel}
        activeLevelName={activeLevelName}
      />
    </div>
  );
}
