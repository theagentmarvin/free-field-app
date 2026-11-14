import { create } from "zustand";

import type {
  Combinator,
  FilterPresetRecord,
} from "@ff/types";

/**
 * Task 21: description of the currently-selected element. The
 * store holds the latest pick; `useViewerSelectionSync` mirrors it
 * to the viewer's `OBCF.Highlighter`, and the PropertiesDrawer
 * reads it to populate the side panel.
 *
 * We intentionally do NOT carry the world-space `point` here —
 * once the visual highlight takes over, the point is no longer
 * needed for the drawer UI. If a future task needs the pick
 * location (snap-to-annotation, measurement anchor), add it back
 * as an optional field.
 */
export interface SelectedElement {
  modelId: string;
  expressId: number;
}

/**
 * Models tool store — read surface for the Models module.
 *
 * Holds UI state for the Models chrome (active nav panel, active
 * building, hydration, active level) and the filters tree (auto
 * folders + custom tree).
 *
 * The active building lives HERE (not in ModelsApp's React state)
 * because the building switcher moved OUT of the Models module and
 * into the app-level module rail (`apps/settings/src/shell/
 * LeftRail.tsx`). The rail and the Models module are different
 * React trees, so the shared store is the seam that lets the rail
 * switch buildings and have the 3D viewer + filters follow.
 *
 * `activeStoreyName` is consumed by <IfcViewer>'s `viewerSlice` prop
 * (mirrors Settings's useViewerStore pattern). Settings's writer
 * flips this when the user opens a level plan; Models's slice is
 * read-only here — it just needs the IfcViewer to render.
 *
 * Persistence:
 *   `filters.auto.expanded`      → `localStorage` `ff:mainapp:auto-folder-expanded`
 *   `filters.customTree` (leaves)→ `dexie.filterPresets` (Task 20D)
 *
 * The custom filter tree DOES persist this session — Task 20D adds
 * Dexie v6 `filterPresets` table + `useFilterPresetsForBuilding`
 * live query + `hydrateFilterPresets` action (called on building
 * change). See the Task 20D filter spec.
 */

/**
 * The tenants of the ONE floating nav panel (wave 35 — toolbar nav
 * redesign). `props` is the Properties surface: it opens in the SAME
 * slot when an element is selected, and it is NOT button-driven — no
 * nav button is highlighted while it shows.
 */
export type NavPanelId = "models" | "filters" | "tasks" | "props";

export interface ModelsToolState {
  /** True after the first localStorage read completes (or fails silently). */
  hydrated: boolean;
  /**
   * Which tenant owns the ONE floating nav panel (wave 35).
   *
   * `null` = the panel is closed. `"props"` is set by the selection
   * sync (an element was picked) and cleared on deselect — it is
   * deliberately NOT a button state, so no nav button is highlighted
   * while Properties shows.
   */
  activeNavPanel: NavPanelId | null;
  /**
   * The building the Models module is showing. Owned by the store
   * because the building switcher lives in the app-level module
   * rail, outside the Models React tree. `null` = nothing selected.
   */
  activeBuildingId: string | null;
  /**
   * Active storey (level plan) name. Drives the <IfcViewer>'s
   * `viewerSlice.activeStoreyName`. null = default 3D perspective.
   * Models doesn't open level plans in this session; this stays null
   * but the seam exists for a future "Levels" picker.
   */
  activeStoreyName: string | null;

  // ─── Task 21: selection (single-element MVP) ───────────────────────────────
  /**
   * Currently-selected element. Single-select MVP scope — the
   * underlying IfcViewer can hold multi-select (the Highlighter
   * API supports it natively), but the Models UI surface treats
   * the selection as "one element at a time". A future task can
   * relax this by changing the type to
   * `SelectedElement[]` and threading the array through
   * `useViewerSelectionSync`.
   *
   * `null` means "no selection". Visual highlight in the 3D
   * viewport is driven by `useViewerSelectionSync` (a hook that
   * subscribes to this state and calls
   * `viewerRef.current.selectElement / clearSelection`).
   * PropertiesDrawer reads from this state to populate the side
   * panel.
   */
  selection: SelectedElement | null;
  /**
   * Replace the current selection. Pass null to clear.
   * Synchronous store update — the Highlighter visual feedback
   * follows via the sync hook.
   */
  selectElement: (payload: SelectedElement | null) => void;
  /**
   * Clear the current selection. Convenience wrapper for
   * `selectElement(null)`. Wired to the PropertiesDrawer's
   * close button.
   */
  clearSelection: () => void;

  // ─── Filters (Addendum B) ──────────────────────────────────────────────
  /**
   * The filters panel state. Two halves:
   *
   *  - `auto`: two locked folders (Models / Levels) whose entries are
   *    derived from a Dexie live query at render time. Their `enabled`
   *    set is the active set per folder (empty = wildcard); `hidden`
   *    is the explicit-visibility-off set; `expanded` is per-folder
   *    collapse state.
   *
   *  - `customTree`: user-created folders + filter leaves (nested
   *    arbitrarily). `customActive` / `customHidden` are maps keyed
   *    by group id, value = Set of entry ids. Empty active per group
   *    = wildcard for that group.
   */
  filters: FilterState;

  /**
   * Currently-edited preset id (Task 20D). When non-null, the
   * CustomFilterBuilder modal opens in "edit" mode, hydrates its
   * state from this preset, and dispatches `updateCustomFilter` on
   * save instead of `upsertCustomFilter` (which is the create path).
   * Cleared on cancel / save.
   */
  editingPresetId: string | null;

  /**
   * Open / close / swap the floating nav panel. Pass `null` to close.
   * The toggle logic (inactive → open, active → close, other → swap)
   * lives in the toolbar component, not here.
   */
  setActiveNavPanel: (panel: NavPanelId | null) => void;
  /**
   * Switch the active building. Called by the module rail's building
   * switcher; the Models viewer, the levels list and the filter
   * presets all re-scope on it.
   */
  setActiveBuildingId: (buildingId: string | null) => void;
  setHydrated: (v: boolean) => void;
  setActiveStoreyName: (name: string | null) => void;

  // Auto-folder actions (Models / Levels)
  setFilterEnabled: (group: "models" | "levels", entryId: string, enabled: boolean) => void;
  setFilterHidden: (group: "models" | "levels", entryId: string, hidden: boolean) => void;
  setAutoFolderExpanded: (group: "models" | "levels", expanded: boolean) => void;

  // Custom-folder / custom-filter actions
  /** Create a folder under `parentId` (null = top-level). Returns the new id. */
  createCustomFolder: (parentId: string | null, label: string) => string;
  /**
   * Task 20D: replaced the old `createCustomFilter(parentId, preset)`.
   * Now takes the parent id AND a full preset (which may or may not
   * already carry an `id`). If `preset.id` matches an existing leaf
   * in `parentId`, that leaf is updated in place (label + preset
   * replaced, leaf id preserved). Otherwise a new leaf is created.
   * Returns the leaf id (existing or new).
   */
  upsertCustomFilter: (parentId: string, preset: FilterPreset) => string;
  /**
   * Explicit update path used by the editor flow. Looks up the leaf
   * by id, replaces its preset + label. Caller persists via
   * `useFilterPresetsForBuilding.save`. No-op for unknown ids.
   */
  updateCustomFilter: (leafId: string, preset: FilterPreset) => void;
  /**
   * Delete a single filter leaf (NOT a folder — use `deleteCustom`
   * for folders). Does NOT cascade (leaves have no descendants).
   * The companion Dexie call `useFilterPresetsForBuilding.remove(id)`
   * is the caller's responsibility. No-op for unknown ids.
   */
  deleteCustomFilter: (leafId: string) => void;
  /** Rename a custom node (folder or filter). */
  renameCustom: (nodeId: string, label: string) => void;
  /**
   * Delete a custom node. Folders cascade-delete their descendants;
   * their `customActive` / `customHidden` entries are pruned too.
   * Leaves go through `deleteCustomFilter` (no cascade) — see
   * Task 20D §"Store Changes" for why we don't cascade for leaves.
   * No-op for unknown ids.
   */
  deleteCustom: (nodeId: string) => void;
  toggleCustomExpanded: (folderId: string) => void;
  setCustomFilterActive: (groupId: string, entryId: string, active: boolean) => void;
  setCustomFilterHidden: (groupId: string, entryId: string, hidden: boolean) => void;

  // Task 20D: Dexie hydration + editor selection
  /**
   * Replace the entire custom tree based on Dexie-loaded records.
   * Idempotent — safe to call on every Dexie live-query change. The
   * records are normalized into folders (one synthetic top-level
   * folder per `buildingId`) and leaves (one leaf per record).
   * Records without a parent go to the synthetic folder.
   */
  hydrateFilterPresets: (
    records: FilterPresetRecord[],
    options?: { parentId?: string | null; folderLabel?: string },
  ) => void;
  /**
   * Mark `leafId` as the currently-edited preset. The FiltersPanel
   * watches this and opens the CustomFilterBuilder in edit mode.
   * `null` clears the selection (used on cancel / save).
   */
  setEditingPreset: (leafId: string | null) => void;
}

// ────────────────────────────────────────────────────────────────────────
// Filter state types
// ────────────────────────────────────────────────────────────────────────

/**
 * An id for a filter entry. For auto entries this is the
 * IfcFileRecord.id (Models) or StoreyRecord.id (Levels). For custom
 * entries it's a uuid.
 */
export type FilterEntryId = string;

/**
 * An id for a filter group. `"models"` and `"levels"` are reserved
 * for the auto folders; any other string is a user-created group.
 */
export type FilterGroupId = "models" | "levels" | string;

export interface AutoFilterGroupState {
  /** Active set. Empty = wildcard (show all entries in this folder). */
  enabled: Set<FilterEntryId>;
  /** Explicit visibility off (always hidden regardless of active). */
  hidden: Set<FilterEntryId>;
}

// ────────────────────────────────────────────────────────────────────────
// Filter types (Task 20C-Part 2) — adapted from ifc-excel-updater
// ~/projects/ifc-excel-updater/src/components/CustomFilterBuilder.tsx
// and ~/projects/ifc-excel-updater/src/types/index.ts
// ────────────────────────────────────────────────────────────────────────

/** Supported filter operators for custom property rules.
 *
 * Numeric operators (`greater_than`, `less_than`,
 * `greater_than_or_equal`, `less_than_or_equal`) are string-encoded
 * here — the evaluation engine in Task 19 parses at compare-time
 * and falls back to string compare for non-numeric values.
 *
 * Emptiness operators (`is_empty`, `is_not_empty`) check property
 * presence only — the rule's `value` field is ignored. The
 * `CustomFilterBuilder` handles this by skipping the value-required
 * guard in `handleAdd` for these operators (see VALUE_AGNOSTIC).
 */
export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "does_not_contain"
  | "in"
  | "not_in"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal"
  | "is_empty"
  | "is_not_empty";

/** A single filter rule targeting one IFC property. */
export interface FilterRule {
  id: string;
  /** Qualified name "Pset_WallCommon.FireRating". */
  property: string;
  operator: FilterOperator;
  /**
   * The match value. For `in` / `not_in` operators, this is a
   * comma-separated string parsed at evaluation time.
   */
  value: string;
}

/**
 * Task 20D — re-export the persistence-layer types so the rest of
 * the Models app continues to import everything from
 * `modelsToolStore`. The `Combinator` and `ConditionGroup` shapes
 * are owned by `@ff/types`; the legacy `FilterPreset.rules` field is
 * replaced with `groups: ConditionGroup[]`.
 *
 * We re-export `Combinator` and `ConditionGroup` so existing
 * downstream imports (`import type { Combinator } from "../modelsToolStore"`)
 * keep working during the migration.
 *
 * For the in-memory model we narrow `ConditionGroup.rules` to
 * `FilterRule[]` (the strict operator-typed shape) instead of
 * `FilterRuleLike[]` (the loose persistence shape). The runtime
 * serialization is identical (strings all the way down) — this is a
 * pure type-level narrowing.
 */
export type { Combinator } from "@ff/types";
export interface ConditionGroup {
  id: string;
  combinator: Combinator;
  rules: FilterRule[];
}

/**
 * A saved preset containing one or more `ConditionGroup`s. Within
 * each group, rules join by `group.combinator`; across groups, they
 * join by `preset.combinator`. The default for both is "AND" — the
 * user explicitly opts into OR via the "+ OR group" affordance in
 * the UI.
 *
 * `id` is the leaf's stable identity; it's preserved across edits
 * and is the primary key for the Dexie `filterPresets` table.
 */
export interface FilterPreset {
  id: string;
  name: string;
  /** How the groups within this preset join. Defaults to "AND". */
  combinator: Combinator;
  /** One or more named groups of rules. Defaults to one AND group. */
  groups: ConditionGroup[];
}

/**
 * A user-created folder (Custom section). Nests via `parentId`.
 * The top-level Custom section is the array of groups with
 * `parentId === null`.
 */
export interface UserFilterGroup {
  id: string;
  kind: "user";
  label: string;
  /** null = top-level custom; otherwise the parent group's id. */
  parentId: string | null;
  expanded: boolean;
  children: UserFilterNode[];
}

/** A leaf filter inside a user folder. */
export interface UserFilterLeaf {
  id: string;
  kind: "filter";
  label: string;
  parentId: string;
  /**
   * The full filter preset (groups + rules + name). Task 20C-Part 2:
   * lifted verbatim from ifc-excel-updater; Task 20D migrates from
   * `preset.rules: FilterRule[]` to `preset.groups: ConditionGroup[]`.
   * The leaf's `label` mirrors `preset.name` so the CustomSection
   * rendering doesn't need to know about the preset shape.
   */
  preset: FilterPreset;
}

/** Either a sub-folder or a filter leaf. */
export type UserFilterNode = UserFilterGroup | UserFilterLeaf;

export interface FilterState {
  auto: {
    models: AutoFilterGroupState;
    levels: AutoFilterGroupState;
    expanded: { models: boolean; levels: boolean };
  };
  /** Top-level custom groups (parentId === null). Nested groups live inside their parent. */
  customTree: UserFilterGroup[];
  /**
   * Map from groupId → Set of entryIds that are "active" (multi-select
   * funnel toggled ON). Empty active per group = wildcard for THAT
   * group (does not remove from the result set; see filterResolution).
   */
  customActive: Map<string, Set<string>>;
  /** Map from groupId → Set of entryIds that are hidden (eye-off). */
  customHidden: Map<string, Set<string>>;
}

// ────────────────────────────────────────────────────────────────────────
// Initial state + simple id helper (no uuid dep here — uses Math.random).
// ────────────────────────────────────────────────────────────────────────

function makeId(): string {
  // Lightweight random id. Not crypto-strong; this is just a UI
  // session-scoped key for custom filter nodes.
  return (
    "c-" +
    Math.random().toString(36).slice(2, 10) +
    Date.now().toString(36)
  );
}

function makeEmptyGroupState(): AutoFilterGroupState {
  return { enabled: new Set(), hidden: new Set() };
}

function makeInitialFilterState(): FilterState {
  return {
    auto: {
      models: makeEmptyGroupState(),
      levels: makeEmptyGroupState(),
      expanded: { models: true, levels: false },
    },
    customTree: [],
    customActive: new Map(),
    customHidden: new Map(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Custom-tree mutation helpers (pure, take a tree and return a new one)
// ────────────────────────────────────────────────────────────────────────

function findGroupById(
  tree: UserFilterGroup[],
  id: string,
): UserFilterGroup | null {
  for (const g of tree) {
    if (g.id === id) return g;
    if (g.children.length > 0) {
      const found = findGroupById(
        g.children.filter((c): c is UserFilterGroup => c.kind === "user"),
        id,
      );
      if (found) return found;
    }
  }
  return null;
}

/** Find a filter leaf anywhere in the tree by id. Returns the leaf and its parent group. */
function findLeafById(
  tree: UserFilterGroup[],
  id: string,
): { leaf: UserFilterLeaf; parent: UserFilterGroup } | null {
  for (const g of tree) {
    for (const c of g.children) {
      if (c.id === id && c.kind === "filter") {
        return { leaf: c, parent: g };
      }
    }
    if (g.children.some((c) => c.kind === "user")) {
      const subFolders = g.children.filter(
        (c): c is UserFilterGroup => c.kind === "user",
      );
      const found = findLeafById(subFolders, id);
      if (found) return found;
    }
  }
  return null;
}

function mapTree(
  tree: UserFilterGroup[],
  fn: (g: UserFilterGroup) => UserFilterGroup,
): UserFilterGroup[] {
  return tree.map((g) => {
    const next = fn(g);
    if (next.children.length === 0) return next;
    const subFolders = next.children.filter(
      (c): c is UserFilterGroup => c.kind === "user",
    );
    const leaves = next.children.filter(
      (c): c is UserFilterLeaf => c.kind === "filter",
    );
    const remapped = mapTree(subFolders, fn);
    const merged: UserFilterNode[] = [...remapped, ...leaves];
    return { ...next, children: merged };
  });
}

function removeNodeFromTree(
  tree: UserFilterGroup[],
  id: string,
): UserFilterGroup[] {
  const out: UserFilterGroup[] = [];
  for (const g of tree) {
    if (g.id === id) continue;
    const filteredChildren = g.children.filter((c) => c.id !== id);
    const newChildren: UserFilterNode[] = filteredChildren.map((c) => {
      if (c.kind === "user") {
        const subFolders = c.children.filter(
          (cc): cc is UserFilterGroup => cc.kind === "user",
        );
        const leaves = c.children.filter(
          (cc): cc is UserFilterLeaf => cc.kind === "filter",
        );
        return {
          ...c,
          children: [...removeNodeFromTree(subFolders, id), ...leaves],
        };
      }
      return c;
    });
    out.push({ ...g, children: newChildren });
  }
  return out;
}

/** Collect every group id under a given root group (inclusive). */
function collectDescendantGroupIds(group: UserFilterGroup): string[] {
  const out: string[] = [group.id];
  for (const c of group.children) {
    if (c.kind === "user") {
      out.push(...collectDescendantGroupIds(c));
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Store
// ────────────────────────────────────────────────────────────────────────

export const useModelsToolStore = create<ModelsToolState>((set, get) => ({
  hydrated: false,
  activeNavPanel: null,
  activeBuildingId: null,
  activeStoreyName: null,
  selection: null,
  filters: makeInitialFilterState(),
  editingPresetId: null,

  setActiveNavPanel: (panel) => set({ activeNavPanel: panel }),
  setActiveBuildingId: (buildingId) => set({ activeBuildingId: buildingId }),
  setHydrated: (v) => set({ hydrated: v }),
  setActiveStoreyName: (name) => set({ activeStoreyName: name }),

  // Task 21: selection actions. Single-element MVP. Both actions
  // are plain `set(...)` calls — no async, no batching. The
  // Highlighter visual update happens in a separate effect driven
  // by `useViewerSelectionSync`.
  selectElement: (payload) => set({ selection: payload }),
  clearSelection: () => set({ selection: null }),

  // ── Auto-folder actions ────────────────────────────────────────────────

  setFilterEnabled: (group, entryId, enabled) =>
    set((state) => {
      const next = { ...state.filters };
      const target = next.auto[group];
      const newEnabled = new Set(target.enabled);
      if (enabled) newEnabled.add(entryId);
      else newEnabled.delete(entryId);
      next.auto = {
        ...next.auto,
        [group]: { enabled: newEnabled, hidden: new Set(target.hidden) },
      };
      return { filters: next };
    }),

  setFilterHidden: (group, entryId, hidden) =>
    set((state) => {
      const next = { ...state.filters };
      const target = next.auto[group];
      const newHidden = new Set(target.hidden);
      if (hidden) newHidden.add(entryId);
      else newHidden.delete(entryId);
      next.auto = {
        ...next.auto,
        [group]: { enabled: new Set(target.enabled), hidden: newHidden },
      };
      return { filters: next };
    }),

  setAutoFolderExpanded: (group, expanded) =>
    set((state) => {
      const next = { ...state.filters };
      next.auto = {
        ...next.auto,
        expanded: { ...next.auto.expanded, [group]: expanded },
      };
      return { filters: next };
    }),

  // ── Custom actions ─────────────────────────────────────────────────────

  createCustomFolder: (parentId, label) => {
    const id = makeId();
    set((state) => {
      const next = { ...state.filters };
      const newGroup: UserFilterGroup = {
        id,
        kind: "user",
        label,
        parentId,
        expanded: true,
        children: [],
      };
      if (parentId === null) {
        next.customTree = [...state.filters.customTree, newGroup];
      } else {
        next.customTree = mapTree(state.filters.customTree, (g) => {
          if (g.id !== parentId) return g;
          return { ...g, children: [...g.children, newGroup] };
        });
      }
      next.customActive = new Map(state.filters.customActive);
      next.customHidden = new Map(state.filters.customHidden);
      next.customActive.set(id, new Set());
      next.customHidden.set(id, new Set());
      return { filters: next };
    });
    return id;
  },

  upsertCustomFilter: (parentId, preset) => {
    // Look up an existing leaf with the same preset id under this parent.
    // If found, replace the preset + label in place (preserving the leaf id).
    // Otherwise create a fresh leaf with the supplied preset id.
    const state = get();
    const parent = findGroupById(state.filters.customTree, parentId);
    let targetLeafId: string | null = null;
    if (parent) {
      for (const c of parent.children) {
        if (c.kind === "filter" && c.preset.id === preset.id) {
          targetLeafId = c.id;
          break;
        }
      }
    }
    if (targetLeafId !== null) {
      set((s) => {
        const next = { ...s.filters };
        next.customTree = mapTree(s.filters.customTree, (g) => {
          if (g.id !== parentId) return g;
          return {
            ...g,
            children: g.children.map((c) =>
              c.id === targetLeafId && c.kind === "filter"
                ? { ...c, label: preset.name, preset }
                : c,
            ),
          };
        });
        return { filters: next };
      });
      return targetLeafId;
    }
    // New leaf — preserve the preset's id (it's the Dexie primary key).
    const id = preset.id;
    set((state) => {
      const next = { ...state.filters };
      const newLeaf: UserFilterLeaf = {
        id,
        kind: "filter",
        label: preset.name,
        parentId,
        preset,
      };
      next.customTree = mapTree(state.filters.customTree, (g) => {
        if (g.id !== parentId) return g;
        return { ...g, children: [...g.children, newLeaf] };
      });
      next.customActive = new Map(state.filters.customActive);
      next.customHidden = new Map(state.filters.customHidden);
      return { filters: next };
    });
    return id;
  },

  updateCustomFilter: (leafId, preset) =>
    set((state) => {
      const found = findLeafById(state.filters.customTree, leafId);
      if (!found) return state;
      const next = { ...state.filters };
      next.customTree = mapTree(state.filters.customTree, (g) => {
        if (g.id !== found.parent.id) return g;
        return {
          ...g,
          children: g.children.map((c) =>
            c.id === leafId && c.kind === "filter"
              ? { ...c, label: preset.name, preset }
              : c,
          ),
        };
      });
      return { filters: next };
    }),

  deleteCustomFilter: (leafId) =>
    set((state) => {
      const found = findLeafById(state.filters.customTree, leafId);
      if (!found) return state;
      const parentId = found.parent.id;
      const next = { ...state.filters };
      next.customTree = mapTree(state.filters.customTree, (g) => {
        if (g.id !== parentId) return g;
        return { ...g, children: g.children.filter((c) => c.id !== leafId) };
      });
      next.customActive = new Map(state.filters.customActive);
      next.customHidden = new Map(state.filters.customHidden);
      const active = next.customActive.get(parentId);
      if (active) {
        const nextActive = new Set(active);
        nextActive.delete(leafId);
        next.customActive.set(parentId, nextActive);
      }
      const hidden = next.customHidden.get(parentId);
      if (hidden) {
        const nextHidden = new Set(hidden);
        nextHidden.delete(leafId);
        next.customHidden.set(parentId, nextHidden);
      }
      // Clear editing selection if it pointed at the deleted leaf.
      if (state.editingPresetId === leafId) {
        return { filters: next, editingPresetId: null };
      }
      return { filters: next };
    }),

  renameCustom: (nodeId, label) =>
    set((state) => {
      const next = { ...state.filters };
      next.customTree = mapTree(state.filters.customTree, (g) => {
        if (g.id === nodeId) return { ...g, label };
        // Also check direct filter leaves
        const leafMatch = g.children.find(
          (c) => c.id === nodeId && c.kind === "filter",
        );
        if (leafMatch && leafMatch.kind === "filter") {
          return {
            ...g,
            children: g.children.map((c) =>
              c.id === nodeId && c.kind === "filter" ? { ...c, label } : c,
            ),
          };
        }
        return g;
      });
      return { filters: next };
    }),

  deleteCustom: (nodeId) => {
    const state = get();
    const target = findGroupById(state.filters.customTree, nodeId);
    const isGroup = target !== null;
    if (isGroup) {
      // Folder: cascade (legacy behaviour).
      const prunedGroupIds: string[] = collectDescendantGroupIds(target);
      set((s) => {
        const next = { ...s.filters };
        next.customTree = removeNodeFromTree(s.filters.customTree, nodeId);
        next.customActive = new Map(s.filters.customActive);
        next.customHidden = new Map(s.filters.customHidden);
        for (const gid of prunedGroupIds) {
          next.customActive.delete(gid);
          next.customHidden.delete(gid);
        }
        return { filters: next };
      });
    } else {
      // Leaf: no cascade — delegate to deleteCustomFilter which also
      // prunes the leaf's active/hidden entries.
      get().deleteCustomFilter(nodeId);
    }
  },

  toggleCustomExpanded: (folderId) =>
    set((state) => {
      const next = { ...state.filters };
      next.customTree = mapTree(state.filters.customTree, (g) => {
        if (g.id !== folderId) return g;
        return { ...g, expanded: !g.expanded };
      });
      return { filters: next };
    }),

  setCustomFilterActive: (groupId, entryId, active) =>
    set((state) => {
      const next = { ...state.filters };
      next.customActive = new Map(state.filters.customActive);
      const set0 = new Set(next.customActive.get(groupId) ?? []);
      if (active) set0.add(entryId);
      else set0.delete(entryId);
      next.customActive.set(groupId, set0);
      return { filters: next };
    }),

  setCustomFilterHidden: (groupId, entryId, hidden) =>
    set((state) => {
      const next = { ...state.filters };
      next.customHidden = new Map(state.filters.customHidden);
      const set0 = new Set(next.customHidden.get(groupId) ?? []);
      if (hidden) set0.add(entryId);
      else set0.delete(entryId);
      next.customHidden.set(groupId, set0);
      return { filters: next };
    }),

  // ── Task 20D: Dexie hydration + editor selection ───────────────────────

  hydrateFilterPresets: (records, options) => {
    const parentId = options?.parentId ?? null;
    const folderLabel = options?.folderLabel ?? "Filters";
    set((state) => {
      const next = { ...state.filters };
      const nextActive = new Map(state.filters.customActive);
      const nextHidden = new Map(state.filters.customHidden);

      // Find or create the parent folder. We synthesise one if the
      // user hasn't created any custom folders yet — this keeps the
      // Custom section non-empty after a fresh Dexie load.
      let folder: UserFilterGroup | null = null;
      if (parentId === null) {
        folder = state.filters.customTree[0] ?? null;
      } else {
        folder = findGroupById(state.filters.customTree, parentId);
      }
      let nextTree: UserFilterGroup[];
      if (!folder) {
        const newFolderId = makeId();
        const newFolder: UserFilterGroup = {
          id: newFolderId,
          kind: "user",
          label: folderLabel,
          parentId: null,
          expanded: true,
          children: [],
        };
        nextTree = [...state.filters.customTree, newFolder];
        nextActive.set(newFolderId, new Set());
        nextHidden.set(newFolderId, new Set());
        folder = newFolder;
      } else {
        nextTree = state.filters.customTree;
      }

      // Build the leaf list from records. The Dexie record's `groups`
      // is `ConditionGroup[]` from `@ff/types`; the store narrows
      // `rules` to `FilterRule[]` (with the `FilterOperator` enum).
      // The wire shape is the same (strings all the way down) so we
      // cast at this boundary.
      const leaves: UserFilterLeaf[] = records.map((r) => ({
        id: r.id,
        kind: "filter" as const,
        label: r.name,
        parentId: folder!.id,
        preset: {
          id: r.id,
          name: r.name,
          combinator: r.combinator,
          groups: r.groups.map((g) => ({
            id: g.id,
            combinator: g.combinator,
            rules: g.rules.map((rule) => ({
              id: rule.id,
              property: rule.property,
              operator: rule.operator as FilterOperator,
              value: rule.value,
            })),
          })),
        },
      }));

      // Preserve any sub-folders that live inside `folder`; replace
      // its leaf children with the freshly-built leaves. Nested
      // folders inside the records are NOT supported in this session
      // (we keep the persistence shape flat: one row per leaf) — if
      // the user has created nested folders via the UI, they survive
      // this re-render unchanged.
      const subFolders = folder.children.filter(
        (c): c is UserFilterGroup => c.kind === "user",
      );
      const rebuilt: UserFilterGroup = {
        ...folder,
        children: [...subFolders, ...leaves],
      };

      // Walk the tree to splice `rebuilt` in (top-level OR nested).
      nextTree = mapTree(nextTree, (g) => (g.id === rebuilt.id ? rebuilt : g));

      // Prune stale entries from customActive / customHidden maps
      // (e.g. presets deleted while the panel was unmounted). Do NOT
      // auto-activate hydrated leaves — filters start OFF by default;
      // the user explicitly clicks the funnel icon to activate them.
      const validIds = new Set(leaves.map((l) => l.id));
      for (const [gid, set0] of nextActive) {
        const filtered = new Set([...set0].filter((id) => validIds.has(id)));
        if (filtered.size === 0) nextActive.delete(gid);
        else nextActive.set(gid, filtered);
      }
      for (const [gid, set0] of nextHidden) {
        if (gid === folder.id) continue;
        const filtered = new Set([...set0].filter((id) => validIds.has(id)));
        if (filtered.size === 0) nextHidden.delete(gid);
        else nextHidden.set(gid, filtered);
      }

      return {
        filters: {
          ...next,
          customTree: nextTree,
          customActive: nextActive,
          customHidden: nextHidden,
        },
      };
    });
  },

  setEditingPreset: (leafId) => set({ editingPresetId: leafId }),
}));

// ────────────────────────────────────────────────────────────────────────
// Persistence helper (used by the hydration hook).
// ────────────────────────────────────────────────────────────────────────

const STORAGE_KEY_AUTO_EXPANDED = "ff:mainapp:auto-folder-expanded";

/**
 * Read the persisted auto-folder expanded state. Returns `null` if no
 * value is stored or the payload is unparseable. Caller is responsible
 * for merging into the live filter state.
 */
export function loadPersistedAutoExpanded(): {
  models: boolean;
  levels: boolean;
} | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_AUTO_EXPANDED);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "models" in parsed &&
      "levels" in parsed
    ) {
      const obj = parsed as { models: unknown; levels: unknown };
      if (typeof obj.models === "boolean" && typeof obj.levels === "boolean") {
        return { models: obj.models, levels: obj.levels };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the auto-folder expanded state. Failures are swallowed
 * (private mode, quota, etc.).
 */
export function persistAutoExpanded(expanded: {
  models: boolean;
  levels: boolean;
}): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY_AUTO_EXPANDED,
      JSON.stringify(expanded),
    );
  } catch {
    // localStorage unavailable — ignore.
  }
}

/**
 * Task 20D — backward-compatible default preset factory. Returns a
 * fresh `FilterPreset` with one AND group and no rules. The caller
 * (the CustomFilterBuilder init effect) seeds the editor state from
 * this when no `editingPreset` is supplied.
 */
export function makeEmptyPreset(name = ""): FilterPreset {
  return {
    id: makeId(),
    name,
    combinator: "AND",
    groups: [
      {
        id: makeId(),
        combinator: "AND",
        rules: [],
      },
    ],
  };
}

// Note: types are exported alongside the store from this file; the
// Dexie persistence record (`FilterPresetRecord`) and the wire types
// (`Combinator`, `ConditionGroup`) live in @ff/types and are
// re-exported above.
