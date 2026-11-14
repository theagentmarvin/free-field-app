// packages/ff-viewer-tools/src/components/useFiltersPanelController.ts
//
// Wave 35 (toolbar-nav redesign) — the shared controller behind the
// filters UI.
//
// Before this wave there was ONE FiltersPanel that rendered BOTH
// sections (Auto → Models/Levels, Custom → user filters). The
// redesign splits them into two separate TENANTS of the one floating
// nav panel:
//
//   "Models & Levels" → the Auto section (models + levels)
//   "Filters"         → the Custom section (folders + filter leaves)
//
// Both bodies need the SAME wiring (Dexie live queries, store
// actions, preset hydration, the create/edit dialogs). Duplicating
// that wiring in two components would let the two drift, so it lives
// here instead: the orchestrator (<FiltersPanel>) and the two panel
// bodies all consume these hooks. The orchestrator's store wiring is
// unchanged — only its location moved.
//
// Nothing in here is Models-specific: it reads the injected
// `ViewerToolsDataSource`, exactly like the panel did before.

import {
  useCallback,
  useEffect,
  useState,
} from "react";

import { useLiveQuery } from "dexie-react-hooks";

import { useViewerToolsDataSource } from "../dataSource";

import type { AutoFilterEntry } from "../dataSource";
import type { FilterPreset, FilterState } from "../modelsToolStore";

import {
  loadPersistedAutoExpanded,
  persistAutoExpanded,
  useModelsToolStore,
} from "../modelsToolStore";

import { useFilterEditor } from "../hooks/useFilterEditor";
import { useFilterPresetsForBuilding } from "../hooks/useFilterPresetsForBuilding";
import { usePropertyCatalog } from "../hooks/usePropertyCatalog";

import type { CreateNodeKind } from "./CreateNodeDialog";

// ────────────────────────────────────────────────────────────────────────
// Auto (Models + Levels)
// ────────────────────────────────────────────────────────────────────────

export interface AutoFiltersController {
  models: AutoFilterEntry[];
  levels: AutoFilterEntry[];
  auto: FilterState["auto"];
  onToggleActive: (
    group: "models" | "levels",
    entryId: string,
    enabled: boolean,
  ) => void;
  onToggleHidden: (
    group: "models" | "levels",
    entryId: string,
    hidden: boolean,
  ) => void;
  onToggleExpanded: (
    group: "models" | "levels",
    expanded: boolean,
  ) => void;
}

/**
 * Live queries + store actions for the two AUTO folders (Models and
 * Levels). The Dexie live queries are wrapped around the injected
 * data source so Dexie's global observation keeps them reactive.
 */
export function useAutoFiltersController(
  buildingId: string | null,
): AutoFiltersController {
  const ds = useViewerToolsDataSource();
  const filters = useModelsToolStore((s) => s.filters);
  const setFilterEnabled = useModelsToolStore((s) => s.setFilterEnabled);
  const setFilterHidden = useModelsToolStore((s) => s.setFilterHidden);
  const setAutoFolderExpanded = useModelsToolStore(
    (s) => s.setAutoFolderExpanded,
  );

  // ── Auto: Models — injected data source, wrapped in a live query
  //    so Dexie's global observation keeps it reactive (§B.4). The
  //    version→subtitle mapping + upload-order sort live in the app
  //    adapter (modelsDataSource.ts) now.
  const models = useLiveQuery<AutoFilterEntry[], AutoFilterEntry[]>(
    async () => {
      if (!buildingId) return [];
      return ds.queryModels(buildingId);
    },
    [buildingId, ds],
    [],
  );

  // ── Auto: Levels — injected data source (elevation sort lives in
  //    the adapter). Same reactivity rationale as Models above. ──
  const levels = useLiveQuery<AutoFilterEntry[], AutoFilterEntry[]>(
    async () => {
      if (!buildingId) return [];
      return ds.queryLevels(buildingId);
    },
    [buildingId, ds],
    [],
  );

  // ── Persistence side-effect: write auto.expanded to localStorage ─────
  // (kept in the panel since the spec calls it "user-managed rules"
  // — the store owns the state, the panel owns the side-effect).
  const handleToggleExpanded = useCallback(
    (group: "models" | "levels", expanded: boolean) => {
      setAutoFolderExpanded(group, expanded);
      const next = {
        models: group === "models" ? expanded : filters.auto.expanded.models,
        levels: group === "levels" ? expanded : filters.auto.expanded.levels,
      };
      persistAutoExpanded(next);
    },
    [
      setAutoFolderExpanded,
      filters.auto.expanded.models,
      filters.auto.expanded.levels,
    ],
  );

  // Hydrate the auto-folder expanded state from localStorage once.
  // useState initializer is intentional — runs once per mount.
  const [hydrationDone] = useState<boolean>(() => {
    const persisted = loadPersistedAutoExpanded();
    if (persisted) {
      if (persisted.models !== filters.auto.expanded.models) {
        setAutoFolderExpanded("models", persisted.models);
      }
      if (persisted.levels !== filters.auto.expanded.levels) {
        setAutoFolderExpanded("levels", persisted.levels);
      }
    }
    return true;
  });
  void hydrationDone;

  return {
    models,
    levels,
    auto: filters.auto,
    onToggleActive: setFilterEnabled,
    onToggleHidden: setFilterHidden,
    onToggleExpanded: handleToggleExpanded,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Custom (user filters)
// ────────────────────────────────────────────────────────────────────────

export interface CustomFiltersController {
  /** The custom tree (top-level folders + nested leaves). */
  tree: FilterState["customTree"];
  /** The whole filter state — the custom section reads the active /
   * hidden maps off it. */
  filters: FilterState;
  /** Opens the "new folder" / "new filter" dialogs. */
  onCreateFolder: () => void;
  onCreateFilter: () => void;
  toggleCustomExpanded: (folderId: string) => void;
  setCustomFilterActive: (
    groupId: string,
    entryId: string,
    active: boolean,
  ) => void;
  setCustomFilterHidden: (
    groupId: string,
    entryId: string,
    hidden: boolean,
  ) => void;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  /** Opens the filter builder in EDIT mode for the given leaf. */
  onEditLeaf: (leafId: string) => void;
  /** The dialog currently open (null = none). */
  dialog: CreateNodeKind | null;
  /** The preset being edited (null = create mode). */
  editingPreset: FilterPreset | null;
  /** Closes whichever dialog is open. */
  onCloseDialog: () => void;
  /** Submit handler for the "new folder" dialog. */
  onSubmitFolder: (label: string) => void;
  /** Submit handler for the filter builder (create + edit). */
  onSubmitFilter: (preset: FilterPreset) => void;
  /** The first IFC file of the building — the property catalog seed
   *  for the builder's property picker. */
  firstFileId: string | null;
  /** Property-catalog counters (the footer pill of the legacy panel). */
  catalog: { count: number; psetCount: number; loading: boolean };
}

/**
 * The Custom-section wiring: Dexie-backed preset hydration, the
 * create/edit dialogs and every tree mutation.
 */
export function useCustomFiltersController(
  buildingId: string | null,
): CustomFiltersController {
  const filters = useModelsToolStore((s) => s.filters);
  const editingPresetId = useModelsToolStore((s) => s.editingPresetId);
  const createCustomFolder = useModelsToolStore((s) => s.createCustomFolder);
  const upsertCustomFilter = useModelsToolStore((s) => s.upsertCustomFilter);
  const renameCustom = useModelsToolStore((s) => s.renameCustom);
  const deleteCustom = useModelsToolStore((s) => s.deleteCustom);
  const deleteCustomFilter = useModelsToolStore((s) => s.deleteCustomFilter);
  const hydrateFilterPresets = useModelsToolStore(
    (s) => s.hydrateFilterPresets,
  );
  const setEditingPreset = useModelsToolStore((s) => s.setEditingPreset);
  const toggleCustomExpanded = useModelsToolStore(
    (s) => s.toggleCustomExpanded,
  );
  const setCustomFilterActive = useModelsToolStore(
    (s) => s.setCustomFilterActive,
  );
  const setCustomFilterHidden = useModelsToolStore(
    (s) => s.setCustomFilterHidden,
  );

  // ── Task 20D: Dexie-backed filter-preset hooks ──────────────────────
  const presetsHook = useFilterPresetsForBuilding(buildingId);
  const editorHook = useFilterEditor();

  // Hydrate the in-memory store from Dexie whenever the live query
  // yields a new snapshot. The action is idempotent so re-renders
  // during unrelated state changes are safe.
  useEffect(() => {
    if (!buildingId) return;
    if (presetsHook.loading) return;
    if (presetsHook.error) return;
    hydrateFilterPresets(presetsHook.presets, {
      parentId: null,
      folderLabel: "Filters",
    });
  }, [
    buildingId,
    presetsHook.loading,
    presetsHook.error,
    presetsHook.presets,
    hydrateFilterPresets,
  ]);

  // ── Toolbar dialog state ──────────────────────────────────────────────
  const [dialog, setDialog] = useState<CreateNodeKind | null>(null);

  // ── Smoke test consumer for the property catalog (Task 20C-Part 1
  // §7). The full property selector UI is Task 2's job; here we just
  // wire the hook so the in-memory cache is exercised end-to-end.
  // We pick the first file in the active building (sorted by createdAt to
  // match the existing Models auto-folder ordering) and feed its id
  // to usePropertyCatalog.
  const ds = useViewerToolsDataSource();
  const models = useLiveQuery<AutoFilterEntry[], AutoFilterEntry[]>(
    async () => {
      if (!buildingId) return [];
      return ds.queryModels(buildingId);
    },
    [buildingId, ds],
    [],
  );
  const firstFileId = models.length > 0 ? models[0]!.id : null;
  const propertyCatalog = usePropertyCatalog(firstFileId);

  const openFolderDialog = useCallback(() => setDialog("folder"), []);
  const openFilterDialog = useCallback(() => {
    // Enter CREATE mode (clear any in-flight edit).
    setEditingPreset(null);
    setDialog("filter");
  }, [setEditingPreset]);
  const closeDialog = useCallback(() => {
    setDialog(null);
    // Always clear the editing selection on dialog close so the next
    // open starts in CREATE mode unless the user re-clicks an edit
    // affordance. Editor saves also clear the selection explicitly
    // (see the hook).
    setEditingPreset(null);
  }, [setEditingPreset]);

  // "New folder" submit: a TOP-LEVEL custom folder (per Addendum B
  // §B.1) + close the dialog.
  const handleDialogSubmit = useCallback(
    (label: string) => {
      if (dialog === "folder") {
        createCustomFolder(null, label);
      }
      setDialog(null);
    },
    [dialog, createCustomFolder],
  );

  // Task 20C-Part 2 + Task 20D: the builder produces a full
  // FilterPreset; we drop it into the Custom tree and persist it to
  // Dexie via `useFilterPresetsForBuilding.save`. Per Addendum B §B.1
  // the toolbar creates at the top level of the Custom section — but
  // filters are leaves and must have a parent. Implementation
  // choice: if there's at least one top-level folder, drop the new
  // filter into the LAST one; otherwise create an implicit
  // "(default)" folder named "Filters".
  const handleFilterSubmit = useCallback(
    (preset: FilterPreset) => {
      const topLevel = filters.customTree;
      let parentId: string;
      if (topLevel.length === 0) {
        parentId = createCustomFolder(null, "Filters");
      } else {
        parentId = topLevel[topLevel.length - 1]!.id;
      }
      upsertCustomFilter(parentId, preset);
      // Persist to Dexie (Task 20D). save() stamps updatedAt + handles
      // upsert semantics.
      void presetsHook.save({
        id: preset.id,
        buildingId: buildingId ?? "",
        name: preset.name,
        combinator: preset.combinator,
        groups: preset.groups,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      setDialog(null);
      setEditingPreset(null);
    },
    [
      createCustomFolder,
      upsertCustomFilter,
      presetsHook,
      buildingId,
      filters.customTree,
      setEditingPreset,
    ],
  );

  // Task 20D: edit affordance. Wired through a callback passed to
  // the Custom section so the leaf's "edit" row action can flip the
  // editing selection. The dialog opens in EDIT mode via the
  // editingPreset lookup below.
  const openEditDialog = useCallback(
    (leafId: string) => {
      const editing = editorHook.hydrate(leafId);
      if (!editing) return;
      setEditingPreset(leafId);
      setDialog("filter");
    },
    [editorHook, setEditingPreset],
  );

  const editingPreset = editorHook.draft;

  // Wire leaf deletion to Dexie (Task 20D).
  const handleDeleteCustom = useCallback(
    (nodeId: string) => {
      // Determine if it's a leaf (preset id matches a Dexie row) or a
      // folder (no Dexie row). Preset ids are uuid-shaped; folder ids
      // are the in-memory `c-...` random strings, but we can't tell
      // them apart by string alone. Use the store to inspect: if the
      // node id is present as a leaf under any folder, treat as leaf.
      let isLeaf = false;
      outer: for (const folder of filters.customTree) {
        for (const child of folder.children) {
          if (child.id === nodeId && child.kind === "filter") {
            isLeaf = true;
            break outer;
          }
        }
      }
      if (isLeaf) {
        void presetsHook.remove(nodeId);
        deleteCustomFilter(nodeId);
        if (editingPresetId === nodeId) setEditingPreset(null);
      } else {
        deleteCustom(nodeId);
      }
    },
    [
      filters.customTree,
      presetsHook,
      deleteCustomFilter,
      deleteCustom,
      editingPresetId,
      setEditingPreset,
    ],
  );

  return {
    tree: filters.customTree,
    filters,
    onCreateFolder: openFolderDialog,
    onCreateFilter: openFilterDialog,
    toggleCustomExpanded,
    setCustomFilterActive,
    setCustomFilterHidden,
    renameCustom,
    deleteCustom: handleDeleteCustom,
    onEditLeaf: openEditDialog,
    dialog,
    editingPreset,
    onCloseDialog: closeDialog,
    onSubmitFolder: handleDialogSubmit,
    onSubmitFilter: handleFilterSubmit,
    firstFileId,
    catalog: {
      count: propertyCatalog.count,
      psetCount: propertyCatalog.byPset.size,
      loading: propertyCatalog.loading,
    },
  };
}
