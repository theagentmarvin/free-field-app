// src/ifc/ifcImportOptions.ts
//
// Plain types + constants of the IFC import, with NO web-ifc /
// @thatopen/fragments import. The main-thread side (useIfcPipeline,
// ifcImportClient) imports from here so the app's main chunk never
// pulls in the parser; ./convertIfc.ts (worker / lazy fallback only)
// re-exports everything for backwards compatibility.

/** Progress of one IFC import, as shown in the UI. */
export interface IfcImportProgress {
  /** reading = file bytes, converting = web-ifc + fragments, done. */
  stage: "reading" | "converting" | "done";
  /** Overall 0..1 for the whole import. */
  fraction: number;
  /** Importer sub-step (geometry / attributes / relations / conversion). */
  detail?: string;
}

export interface ConvertIfcOptions {
  /**
   * addAllAttributes() + addAllRelations() on the importer (psets
   * reachable via IsDefinedBy). The app pipeline always passes true
   * via PIPELINE_IFC_IMPORT_OPTIONS (both loadIfc and
   * replaceIfcVersion); false is only for tests / timing scripts.
   */
  includeAllAttributesAndRelations: boolean;
  /**
   * Fragments model guid. Omitted in the app (the importer mints a
   * random one, as before); pinned by tests / the timing script so two
   * outputs can be compared byte for byte.
   */
  modelGuid?: string;
}

/**
 * THE importer configuration for every IFC import the app pipeline
 * runs (useIfcPipeline: loadIfc AND replaceIfcVersion). One shared
 * constant so the two paths can't drift: replaceIfcVersion used to
 * convert without attributes/relations, so a replaced version's .frag
 * had no property sets (properties panel / property index came up
 * empty for it). Frozen — callers must not tweak it per call site.
 */
export const PIPELINE_IFC_IMPORT_OPTIONS: Readonly<ConvertIfcOptions> =
  Object.freeze({ includeAllAttributesAndRelations: true });
