// packages/ff-viewer-tools/src/components/CustomFiltersPanel.tsx
//
// Wave 35 (toolbar-nav redesign) — the "Filters" BODY of the one
// floating nav panel.
//
// It is today's "Custom" section: the user-created tree (folders +
// filter leaves) with create / edit / delete, activate (funnel) and
// hide (switch) per leaf. Presets hydrate per building from the same
// Dexie table the legacy panel used — the store is untouched.
//
// The store wiring lives in `useCustomFiltersController` so this body
// and the legacy <FiltersPanel> orchestrator can never drift apart.

import { FilterAlt, FolderPlus } from "iconoir-react";

import type { CSSProperties } from "react";

import CustomFilterSection from "./CustomFilterSection";
import CustomFilterBuilder from "./CustomFilterBuilder";
import CreateNodeDialog from "./CreateNodeDialog";
import { useCustomFiltersController } from "./useFiltersPanelController";

export interface CustomFiltersPanelProps {
  /**
   * Active building id. Passed in by the host so the Dexie live
   * queries scope to the right building. `null` while the user
   * hasn't picked one yet.
   */
  buildingId: string | null;
}

export default function CustomFiltersPanel({
  buildingId,
}: CustomFiltersPanelProps): JSX.Element {
  const custom = useCustomFiltersController(buildingId);

  return (
    <div data-testid="custom-filters-panel" aria-label="Filters">
      <FiltersToolbar
        onCreateFolder={custom.onCreateFolder}
        onCreateFilter={custom.onCreateFilter}
      />
      <CustomFilterSection
        tree={custom.tree}
        filters={custom.filters}
        onCreateFolder={custom.onCreateFolder}
        onCreateFilter={custom.onCreateFilter}
        toggleCustomExpanded={custom.toggleCustomExpanded}
        setCustomFilterActive={custom.setCustomFilterActive}
        setCustomFilterHidden={custom.setCustomFilterHidden}
        renameCustom={custom.renameCustom}
        deleteCustom={custom.deleteCustom}
        onEditLeaf={custom.onEditLeaf}
      />
      {custom.dialog === "folder" && (
        <CreateNodeDialog
          kind="folder"
          onSubmit={custom.onSubmitFolder}
          onCancel={custom.onCloseDialog}
        />
      )}
      {custom.dialog === "filter" && (
        <CustomFilterBuilder
          open
          fileId={custom.firstFileId}
          onSubmit={custom.onSubmitFilter}
          onCancel={custom.onCloseDialog}
          editingPreset={custom.editingPreset}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Toolbar (create folder, create filter)
// ────────────────────────────────────────────────────────────────────────

const TOOLBAR_BTN = 28;

interface FiltersToolbarProps {
  onCreateFolder: () => void;
  onCreateFilter: () => void;
}

function FiltersToolbar({
  onCreateFolder,
  onCreateFilter,
}: FiltersToolbarProps): JSX.Element {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 9px",
    borderBottom: "1px solid var(--ff-divider)",
  };

  const btnStyle: CSSProperties = {
    width: TOOLBAR_BTN,
    height: TOOLBAR_BTN,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid var(--ff-border)",
    borderRadius: 6,
    color: "var(--ff-text-primary)",
    cursor: "pointer",
    transition: "background 120ms ease, border-color 120ms ease",
  };

  return (
    <div style={rowStyle} role="toolbar" aria-label="Filter actions">
      <button
        type="button"
        aria-label="Create folder"
        title="Create folder"
        onClick={onCreateFolder}
        style={btnStyle}
        className="ff-filter-toolbar-btn"
        data-testid="filters-create-folder"
      >
        <FolderPlus width={16} height={16} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Create filter"
        title="Create filter"
        onClick={onCreateFilter}
        style={btnStyle}
        className="ff-filter-toolbar-btn"
        data-testid="filters-create-filter"
      >
        <FilterAlt width={16} height={16} strokeWidth={1.75} />
      </button>
    </div>
  );
}
