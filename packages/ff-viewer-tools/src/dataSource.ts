// packages/ff-viewer-tools/src/dataSource.ts
//
// The dependency-injection boundary for @ff/viewer-tools.
//
// This package is intentionally Dexie-free and app-schema-free: it
// consumes the 3D scene via @ff/viewer-react's `IfcViewerHandle`
// (the imperative seam) and consumes persisted/queryable data via
// the `ViewerToolsDataSource` adapter injected here.
//
// Why an adapter instead of importing `@core/db`?
//   - The `@core/*` alias resolves into `apps/settings/src/core`.
//     A shared package cannot depend on a specific app's alias
//     without hard-coupling to that app's build. Injecting the
//     query closures keeps the package portable and lets any
//     module (Models today, LinkView in Stage 2) supply its own
//     data plumbing while pointing at the SAME Dexie instance.
//
// Reactivity note: the query methods are plain async closures. The
// package wraps them in `useLiveQuery` (dexie-react-hooks) at the
// call sites that need reactivity. Dexie's `useLiveQuery` observes
// the global Dexie instance regardless of where the query closure
// is *defined* — so injecting a closure that reads `db.foo` from
// the app preserves live-query reactivity exactly as before the
// extraction. The dependency array we pass to `useLiveQuery`
// carries the closure identity + the query key (buildingId /
// fileId), so a stable adapter yields stable subscriptions.

import {
  createContext,
  useContext,
  type ReactNode,
  createElement,
} from "react";

import type { FilterPresetRecord } from "@ff/types";

// ────────────────────────────────────────────────────────────────
// "Lite" data shapes — the package's own view of app records.
// These decouple the package from the app's full Dexie record
// types. The app adapter maps its records → these shapes.
// ────────────────────────────────────────────────────────────────

/**
 * A single entry in an auto filter folder (Models or Levels).
 * Mirrors the former `AutoFilterEntry` from
 * `apps/models/src/components/AutoFilterSection`. Re-exported from
 * the barrel so the section component and the app adapter agree on
 * the shape.
 */
export interface AutoFilterEntry {
  /** ifcFileId (Models) or storeyId (Levels). */
  id: string;
  /** Display label (file name / storey name). */
  label: string;
  /** Secondary line (version tag / elevation). */
  subtitle?: string;
  /** Upload order tiebreak (Models). Optional for Levels. */
  createdAt?: number;
}

/**
 * A property-catalog entry as the tools package consumes it. The
 * app's full `PropertyCatalogEntry` carries `fileId` too; the
 * package only needs `pset` + `name` for grouping.
 */
export interface PropertyCatalogEntryLite {
  pset: string;
  name: string;
}

/**
 * A storey row, reduced to what `useViewerExpressIdMaps` needs to
 * map spatial-structure storey names → app storey ids.
 */
export interface StoreyLite {
  /** Dexie storey id. */
  id: string;
  /** Storey display name (matches the model's spatial-structure name). */
  name: string;
  /** FK → source ifc file id (denormalized), used to build the
   * `${fileId}::${storeyName}` matching key. */
  sourceIfcFileId: string;
}

// ────────────────────────────────────────────────────────────────
// The injected data source.
// ────────────────────────────────────────────────────────────────

export interface ViewerToolsDataSource {
  /**
   * Auto "Models" folder entries for a building: one per ifc file,
   * sorted by upload order (createdAt asc), subtitle = version tag.
   */
  queryModels(buildingId: string): Promise<AutoFilterEntry[]>;
  /**
   * Auto "Levels" folder entries for a building: one per storey of
   * the latest version per file, sorted by elevation asc, subtitle =
   * elevation in metres.
   */
  queryLevels(buildingId: string): Promise<AutoFilterEntry[]>;
  /**
   * Property-name catalog for a single file (schema-only). Empty
   * array when the file has no indexed catalog yet.
   */
  queryPropertyCatalog(fileId: string): Promise<PropertyCatalogEntryLite[]>;
  /**
   * All persisted filter presets for a building, any order (the
   * hook sorts newest-first). Uses the shared `@ff/types`
   * `FilterPresetRecord` wire shape.
   */
  queryFilterPresets(buildingId: string): Promise<FilterPresetRecord[]>;
  /**
   * Upsert a preset. The adapter stamps createdAt/updatedAt and
   * forces the correct buildingId. Returns the stored record.
   */
  saveFilterPreset(preset: FilterPresetRecord): Promise<FilterPresetRecord>;
  /** Hard-delete a preset by id. */
  removeFilterPreset(id: string): Promise<void>;
  /**
   * Resolve a model/file id to its display name (for the properties
   * drawer title). Returns null when unknown.
   */
  queryFileName(modelId: string): Promise<string | null>;
  /**
   * All storeys across the DB (the level-map builder filters by the
   * `${sourceIfcFileId}::${name}` key). Kept broad to mirror the
   * pre-extraction `db.storeys.toArray()` call.
   */
  queryStoreys(): Promise<StoreyLite[]>;
}

// ────────────────────────────────────────────────────────────────
// React context + provider.
// ────────────────────────────────────────────────────────────────

const ViewerToolsDataSourceContext =
  createContext<ViewerToolsDataSource | null>(null);

export interface ViewerToolsProviderProps {
  dataSource: ViewerToolsDataSource;
  children: ReactNode;
}

/**
 * Provide the data source to the viewer-tools capability tree
 * (FiltersPanel, PropertiesDrawer, and the hooks they consume).
 * Wrap the module subtree that mounts these once — e.g. inside
 * `ModelsApp` (and, in Stage 2, the LinkView shell).
 */
export function ViewerToolsProvider({
  dataSource,
  children,
}: ViewerToolsProviderProps): ReactNode {
  return createElement(
    ViewerToolsDataSourceContext.Provider,
    { value: dataSource },
    children,
  );
}

/**
 * Read the injected data source. Throws if used outside a
 * `<ViewerToolsProvider>` — a programming error we surface loudly
 * rather than silently returning empty data.
 */
export function useViewerToolsDataSource(): ViewerToolsDataSource {
  const ds = useContext(ViewerToolsDataSourceContext);
  if (ds === null) {
    throw new Error(
      "useViewerToolsDataSource: no ViewerToolsProvider in the tree. " +
        "Wrap the module subtree in <ViewerToolsProvider dataSource={...}>.",
    );
  }
  return ds;
}
