// packages/ff-viewer-react/src/flattenItemData.ts
//
// Task 22 — extract the per-element data flattening from
// IfcViewer's `getElementData` imperative handle into a pure
// helper. Living in its own module so it can be unit-tested
// without triggering IfcViewer.tsx's heavy module load
// (OBC + Three.js + Stats.js — none of which are needed for the
// flattening math).
//
// The flattening turns the nested IsDefinedBy array (from
// `FragmentsModel.getItemsData` with `{ relations: { IsDefinedBy:
// { attributes: true, relations: false } } }`) into the flat
// `Record<string, string>` shape `PropertiesDrawer` parses with
// `key.indexOf(".")` — each `PsetName.PropertyName = value`
// lands as one key.

/**
 * The shape `FragmentsModel.getItemsData()` returns for a
 * single element when called with the IsDefinedBy config.
 */
export interface IfcItemData {
  [name: string]:
    | { value: unknown; type?: string }
    | ReadonlyArray<Record<string, unknown>>
    | undefined;
}

/**
 * Read a scalar attribute from a TOE entity record. Returns the
 * unwrapped value (or `undefined` if the attribute is missing or
 * not in the expected `{ value, type? }` shape).
 */
function readScalarAttr(
  entity: Record<string, unknown>,
  attrName: string,
): unknown {
  const raw = entity[attrName];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "object" && "value" in (raw as Record<string, unknown>)) {
    return (raw as { value: unknown }).value;
  }
  return raw;
}

/**
 * Wave 63: the flat `PsetName.PropertyName` key is ambiguous when a
 * pset or property name itself contains a "." — splitting on the first
 * dot mis-groups e.g. `Pset 1.2.FireRating`. `flattenItemData` attaches
 * the real grouping to its result under this NON-enumerable symbol, so
 * `Object.entries` / JSON / the filter index never see it.
 */
const PROPERTY_GROUPS = Symbol.for("ff.viewer.propertyGroups");

/** One property set: its name and its `[property, value]` rows. */
export interface PropertyGroup {
  pset: string;
  properties: Array<[string, string]>;
}

/**
 * The pset grouping recorded by `flattenItemData` for `record`, or
 * `null` when the record did not come from it (callers then fall back
 * to splitting the flat key on the first ".").
 */
export function getPropertyGroups(
  record: Record<string, string> | null | undefined,
): PropertyGroup[] | null {
  if (!record) return null;
  const groups = (record as unknown as Record<symbol, unknown>)[PROPERTY_GROUPS];
  return Array.isArray(groups) ? (groups as PropertyGroup[]) : null;
}

/**
 * Flatten a single `ItemData` from `FragmentsModel.getItemsData()`
 * into the `Record<string, string>` shape `PropertiesDrawer`
 * expects. IsDefinedBy entries are unfolded so each
 * `PsetName.PropertyName = value` lands as one key — the
 * drawer's `key.indexOf(".")` parser uses the dot as the
 * pset/property separator.
 *
 * Pure function — extracted from IfcViewer's imperative handle
 * so it can be unit-tested without mounting the React component
 * or mocking the heavy OBC stack.
 */
export function flattenItemData(
  item: IfcItemData,
): Record<string, string> {
  const out: Record<string, string> = {};
  const groups = new Map<string, Array<[string, string]>>();
  for (const key of Object.keys(item)) {
    const attr = item[key];
    if (attr === undefined || attr === null) continue;
    if (key === "IsDefinedBy" && Array.isArray(attr)) {
      // Actual TOE shape (verified empirically 2026-06-23):
      // IsDefinedBy is an array of related-entity objects. Each
      // entity has its own attributes (Name, _category, etc.).
      // For psets (IFCPROPERTYSETDEFINITION category) the actual
      // property values are under HasProperties — an array of
      // IfcPropertySingleValue entities, each with Name +
      // NominalValue (or other value fields depending on type).
      //
      // We skip non-pset entities (e.g., IfcSlabType from
      // IfcRelDefinesByType) and only walk pset/qto entries.
      const psetEntries = attr as ReadonlyArray<Record<string, unknown>>;
      for (const psetEntry of psetEntries) {
        if (!psetEntry || typeof psetEntry !== "object") continue;

        // Get the pset's own Name (its identifier — e.g.
        // "Pset_Foundation", "Qto_WallBaseQuantities").
        const psetName = readScalarAttr(psetEntry, "Name");
        if (typeof psetName !== "string" || psetName.length === 0) {
          continue;
        }

        // HasProperties is the array of IfcPropertySingleValue (and
        // subclass) entities on this pset/qto. Walk it.
        const hasProps = psetEntry["HasProperties"];
        if (!Array.isArray(hasProps)) continue;
        for (const prop of hasProps) {
          if (!prop || typeof prop !== "object") continue;
          const propEntry = prop as Record<string, unknown>;

          const propName = readScalarAttr(propEntry, "Name");
          if (typeof propName !== "string" || propName.length === 0) {
            continue;
          }

          // IfcPropertySingleValue uses NominalValue for the actual
          // value; IfcPropertyBoundedValue uses UpperBoundValue /
          // LowerBoundValue; IfcPropertyEnumeratedValue uses
          // EnumerationValues. Try NominalValue first (most common),
          // then fall back to other value-bearing fields.
          let propValue: unknown = undefined;
          const nominalValue = propEntry["NominalValue"];
          if (nominalValue !== undefined) {
            propValue = readScalarAttr(propEntry, "NominalValue");
          }
          if (propValue === undefined) {
            for (const vKey of [
              "EnumerationValues",
              "UpperBoundValue",
              "LowerBoundValue",
              "Value",
            ]) {
              const v = readScalarAttr(propEntry, vKey);
              if (v !== undefined) {
                propValue = v;
                break;
              }
            }
          }

          const text =
            propValue === null || propValue === undefined
              ? ""
              : typeof propValue === "object"
                ? JSON.stringify(propValue)
                : String(propValue);
          out[`${psetName}.${propName}`] = text;
          let rows = groups.get(psetName);
          if (!rows) groups.set(psetName, (rows = []));
          rows.push([propName, text]);
        }
      }
    } else if (Array.isArray(attr)) {
      // Nested array (e.g. materials, non-IsDefinedBy relations).
      // Stringify as a compact list.
      out[key] = JSON.stringify(
        attr.map((a: { value?: unknown }) => a?.value ?? a),
      );
    } else if (
      typeof attr === "object" &&
      "value" in (attr as Record<string, unknown>)
    ) {
      const v = (attr as { value: unknown }).value;
      out[key] = v === null || v === undefined ? "" : String(v);
    } else {
      out[key] = String(attr);
    }
  }

  // ── Wave 48: synthetic `_IfcClass` emission ─────────────────────
  // `FragmentsModel.getItemData()` returns the IFC entity class under the
  // `_category` key (uppercase, e.g. "IFCWALL"), NOT under `_IfcClass`.
  // Every downstream consumer (the custom-filter evaluator, the
  // PropertiesDrawer class hint, and the right-click context toolbar's
  // category ops) reads `_IfcClass`, so mirror `_category` into that key
  // so the two seams agree. `_category` is left in place for anything
  // that already reads it. The value is already in the catalog's case
  // (`ifcCategoryMap` and web-ifc's `GetNameFromTypeCode` both emit
  // uppercase IFC names), so no re-casing is performed here.
  const category = out["_category"];
  if (category) out["_IfcClass"] = category;

  Object.defineProperty(out, PROPERTY_GROUPS, {
    value: Array.from(groups, ([pset, properties]) => ({ pset, properties })),
    enumerable: false,
  });
  return out;
}

/**
 * Wave 73: add the IFC GlobalId to a flat attribute record without clobbering
 * a `GlobalId` the record already has. Pure; the record's own symbol-keyed
 * pset grouping (see {@link flattenItemData}) is carried over to the copy.
 */
export function mergeGuidIntoAttributes(
  attributes: Record<string, string>,
  guid: string | null,
): { attributes: Record<string, string>; globalId: string | null } {
  const out: Record<string, string> = { ...attributes };
  for (const sym of Object.getOwnPropertySymbols(attributes)) {
    Object.defineProperty(out, sym, {
      value: (attributes as unknown as Record<symbol, unknown>)[sym],
      enumerable: false,
      configurable: true,
    });
  }
  const existing = typeof out.GlobalId === "string" && out.GlobalId !== "" ? out.GlobalId : null;
  const globalId = existing ?? guid;
  if (!existing && guid) out.GlobalId = guid;
  return { attributes: out, globalId };
}

