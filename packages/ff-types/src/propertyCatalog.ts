// src/core/types/propertyCatalog.ts
//
// Dexie v5 record for the property-name catalog indexed at IFC upload
// time. Schema-only — we deliberately omit values, element-type
// applicability, and IFC schema version metadata. The catalog is a
// pre-computed lookup of "what (pset, name) pairs exist in this
// file", keyed by the logical IfcFileRecord.id (NOT version — see
// §6 of the spec: version replacements clear + re-extract).
//
// See docs/task-20c-part-1-property-catalog.md §1.

/**
 * One row per unique (pset, name) pair found while walking
 * IfcRelDefinesByProperties in a single IFC file. The Dexie compound
 * primary key `[fileId+pset+name]` enforces dedup at the DB level.
 */
export interface PropertyCatalogEntry {
  /** FK → IfcFileRecord.id (logical file, persists across version
   * replacements). */
  fileId: string;
  /** The pset name as read from `IfcPropertySet.Name` /
   * `IfcElementQuantity.Name`. Includes `Qto_*` quantity sets. */
  pset: string;
  /** The property or quantity name. We don't distinguish — both
   * `IfcPropertySingleValue.Name` and `IfcQuantityVolume.Name`
   * contribute identically. */
  name: string;
}