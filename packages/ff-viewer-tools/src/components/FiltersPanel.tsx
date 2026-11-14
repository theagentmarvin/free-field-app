import { type CSSProperties } from "react";

import { FilterAlt, FolderPlus } from "iconoir-react";

import AutoFilterSection from "./AutoFilterSection";
import CustomFilterSection from "./CustomFilterSection";
import CreateNodeDialog from "./CreateNodeDialog";
import CustomFilterBuilder from "./CustomFilterBuilder";
import {
  useAutoFiltersController,
  useCustomFiltersController,
} from "./useFiltersPanelController";

// =============================================================================
// Filters panel — thin orchestrator.
//
// Per Addendum B, the panel now has two visual sections:
//
//   ── Auto (managed) ──
//     📁 Models   (live: ifcFiles in active building)
//     📁 Levels   (live: storeys for the latest ifcVersion per file)
//   ── Custom ────────
//     user-created tree (folders + filter leaves)
//
// Task 20D additions:
//   - The Custom tree now hydrates from the Dexie `filterPresets`
//     table on building change via `useFilterPresetsForBuilding`.
//   - Save/delete/edit actions write through to Dexie via the same
//     hook (and `useFilterEditor` for the edit flow).
//   - The CustomFilterBuilder modal opens in EDIT mode when
//     `editingPresetId` is set, otherwise CREATE mode.
//
// Wave 35 (toolbar-nav redesign): the two sections became the bodies
// of two SEPARATE tenants of the one floating nav panel
// (<ModelsLevelsPanel> + <CustomFiltersPanel>). This orchestrator
// stays as the combined view and keeps the SAME store wiring — that
// wiring now lives in `useFiltersPanelController`, shared by all
// three consumers so they can never drift apart.
//
// This file only wires:
//   - the Dexie live queries for the Auto folders (§B.4)
//   - the Dexie live query for the Custom tree (Task 20D)
//   - the store actions for all toggle/expand/create/rename/delete ops
//   - the toolbar (`+` folder / `+` filter → CreateNodeDialog → store)
//   - the header + scroll surface
//
// The actual row rendering lives in AutoFilterSection and
// CustomFilterSection. The resolution logic lives in hooks/filterResolution.
// =============================================================================

const TOOLBAR_BTN = 28;

export interface FiltersPanelProps {
  /**
   * Active building id. Passed in by `MainAppChrome` so the Dexie
   * live queries scope to the right building. `null` while the user
   * hasn't picked one yet.
   */
  buildingId: string | null;
}

export default function FiltersPanel({
  buildingId,
}: FiltersPanelProps): JSX.Element {
  const auto = useAutoFiltersController(buildingId);
  const custom = useCustomFiltersController(buildingId);

  const sectionStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
  };

  return (
    <div
      style={sectionStyle}
      data-testid="models-filters-panel"
      aria-label="Filters"
    >
      <FiltersHeader />
      <FiltersToolbar
        onCreateFolder={custom.onCreateFolder}
        onCreateFilter={custom.onCreateFilter}
      />
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "0 0 8px",
        }}
        role="tree"
        aria-label="Filter tree"
      >
        <AutoFilterSection
          models={auto.models}
          levels={auto.levels}
          filters={auto.auto}
          onToggleActive={auto.onToggleActive}
          onToggleHidden={auto.onToggleHidden}
          onToggleExpanded={auto.onToggleExpanded}
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
      </div>
      {custom.firstFileId && (
        <PropertyCatalogPill
          count={custom.catalog.count}
          psetCount={custom.catalog.psetCount}
          loading={custom.catalog.loading}
        />
      )}
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

// -----------------------------------------------------------------------------
// Smoke-test consumer for the property catalog (Task 20C-Part 1 §7).
// Renders a small footer pill showing the in-memory cache size
// for the first file in the active building. Real property selector
// UI lands in Task 2.
// -----------------------------------------------------------------------------

interface PropertyCatalogPillProps {
  count: number;
  psetCount: number;
  loading: boolean;
}

function PropertyCatalogPill({
  count,
  psetCount,
  loading,
}: PropertyCatalogPillProps): JSX.Element {
  const style: CSSProperties = {
    padding: "6px 16px",
    borderTop: "1px solid var(--ff-divider)",
    fontSize: 11,
    color: "var(--ff-text-secondary, #888)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };
  return (
    <div
      style={style}
      data-testid="property-catalog-pill"
      aria-label="Property catalog status"
    >
      <span>
        {loading
          ? "Loading property catalog…"
          : count === 0
            ? "No properties indexed for this file yet. Re-upload the IFC to extract its property catalog."
            : `${count} properties indexed across ${psetCount} psets`}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Section header
// -----------------------------------------------------------------------------

function FiltersHeader(): JSX.Element {
  const style: CSSProperties = {
    padding: "12px 16px 8px",
    borderBottom: "1px solid var(--ff-divider)",
    fontSize: 13,
    fontWeight: 600,
    color: "var(--ff-text-primary)",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };
  return (
    <div style={style}>
      <span>Filters</span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Toolbar (create folder, create filter) — unchanged visual from mockup.
// -----------------------------------------------------------------------------

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
    padding: "8px 12px",
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
