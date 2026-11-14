// src/ifc/ifcMetadata.ts
//
// FreeField-side IFC metadata extraction: buildings, storeys (+ the
// elements each storey contains) and the (pset, name) property
// catalog. Moved out of hooks/useIfcPipeline.ts so the SAME walk can
// run against an already-open web-ifc model — the one IfcImporter
// parses for the .frag conversion (see ./convertIfc.ts) — instead of
// parsing the file a second time.
//
// `extractIfcMetadata(ifc, modelID)` is synchronous and read-only: it
// only issues GetLineIDsWithType / GetLine / GetLineType calls, so it
// is safe to run on the importer's model before geometry streaming.
// `parseIfc(bytes)` is the standalone (own IfcAPI) wrapper kept for
// tests and as the fallback path.

import * as WEBIFC from "web-ifc";

import type { PropertyCatalogEntry } from "@ff/types";
import { setWebIfcWasmPath } from "./webIfcWasm";
import { disambiguateStoreyNames } from "./storeyNames";

// ---------- IFC parsing ----------

export interface ParsedStorey {
  expressId: number;
  name: string;
  elevation: number;
  height: number | null;
  guid: string;
  /**
   * Express IDs of every IFC element physically or logically
   * contained in this storey, as recorded in
   * `IfcRelContainedInSpatialStructure` (Task 22-amendment).
   * Required for the Models-tool Levels filter — without it, the
   * filter would only toggle the storey entity itself, not the
   * contained walls/slabs/footings etc. Empty array if the file
   * uses `IfcRelAggregates` for containment instead (rare; not
   * covered by this pass).
   */
  containedElementIds: number[];
}

export interface ParsedBuilding {
  expressId: number;
  name: string;
  guid: string;
}

export interface ParsedIfc {
  schema: "IFC2X3" | "IFC4" | "IFC4X3" | "UNKNOWN";
  buildings: ParsedBuilding[];
  storeys: ParsedStorey[];
  /**
   * Schema-only catalog of (pset, name) pairs found in the file.
   * Extracted in the same IfcAPI session as buildings/storeys per
   * Task 20C-Part 1 §2 (Critic's recommendation: no separate
   * worker). Includes `Qto_*` quantity sets alongside `Pset_*`
   * property sets. Empty if the file has no
   * IfcRelDefinesByProperties rows (some IFC files omit them).
   */
  propertyCatalog: PropertyCatalogEntry[];
}

/**
 * Walk an OPEN web-ifc model and pull out building + storey metadata
 * and the property catalog. We don't use the buildings to *create*
 * building records (those are user-defined per spec decision #3).
 *
 * Read-only on the model; does not close it.
 */
export function extractIfcMetadata(
  ifc: WEBIFC.IfcAPI,
  modelID: number,
): ParsedIfc {
  const schema = (ifc.GetModelSchema(modelID) || "UNKNOWN") as
    | "IFC2X3"
    | "IFC4"
    | "IFC4X3"
    | "UNKNOWN";

  const buildings: ParsedBuilding[] = [];
  const storeyMap = new Map<number, ParsedStorey>();
  const propertyCatalog: PropertyCatalogEntry[] = [];
  // Dedup within this file: the same (pset, name) can be reached
  // via multiple IFCRELDEFINESBYPROPERTIES rows. Set-guard before
  // we push to the array — Dexie's compound primary key on
  // `[fileId+pset+name]` also dedupes at the DB level on bulkAdd,
  // but skipping JS-side avoids wasted writes on large files.
  const catalogSeen = new Set<string>();
  // Dedup for the synthetic _IfcClass rows (Task 20C-Part 2 §2).
  // The same IFC class can appear in many IFCRELDEFINESBYPROPERTIES
  // rows; we only want one catalog row per class per file.
  const classSeen = new Set<string>();
  // fileId is unknown at parse time — callers stamp it on the
  // returned rows before persisting. We use a placeholder so the
  // shape matches PropertyCatalogEntry; the loadIfc /
  // replaceIfcVersion flows overwrite it before bulkAdd.
  const catalogFileId = "pending";

  // --- Buildings ---
  const buildingIds = ifc.GetLineIDsWithType(
    modelID,
    WEBIFC.IFCBUILDING,
  );
  for (let i = 0; i < buildingIds.size(); i++) {
    const id = buildingIds.get(i);
    const line = ifc.GetLine(modelID, id, false);
    const name = readIfcString(line?.Name?.value) || "Unnamed Building";
    const guid = readIfcString(line?.GlobalId?.value) || "";
    buildings.push({ expressId: id, name, guid });
  }

  // --- Storeys: direct lookup of IfcBuildingStorey ---
  const storeyIds = ifc.GetLineIDsWithType(
    modelID,
    WEBIFC.IFCBUILDINGSTOREY,
  );
  for (let i = 0; i < storeyIds.size(); i++) {
    const id = storeyIds.get(i);
    const line = ifc.GetLine(modelID, id, false);
    if (!line) continue;
    const name = readIfcString(line.Name?.value) || `Storey ${id}`;
    const elevation = numericOrZero(line.Elevation?.value);
    const guid = readIfcString(line.GlobalId?.value) || "";
    storeyMap.set(id, {
      expressId: id,
      name,
      elevation,
      height: null,
      guid,
      containedElementIds: [],
    });
  }

  // --- IfcRelAggregates (building → storey, etc.) ---
  // We don't *act* on these for storey extraction (direct lookup
  // already covers everything IfcBuildingStorey-typed), but walking
  // them surfaces storeys declared in schemas where the type ID
  // doesn't match (rare, defensive). We add any aggregate child
  // that turns out to be a storey.
  const relAggIds = ifc.GetLineIDsWithType(
    modelID,
    WEBIFC.IFCRELAGGREGATES,
  );
  for (let i = 0; i < relAggIds.size(); i++) {
    const rel = ifc.GetLine(modelID, relAggIds.get(i), false);
    if (!rel) continue;
    const relatedObjs = Array.isArray(rel.RelatedObjects)
      ? rel.RelatedObjects
      : [];
    for (const ref of relatedObjs) {
      const childId = ref?.value;
      if (typeof childId !== "number") continue;
      if (storeyMap.has(childId)) continue;
      const childLine = ifc.GetLine(modelID, childId, false);
      if (!childLine) continue;
      const childType = (childLine as { constructor?: { name?: string } })
        .constructor?.name ?? "";
      if (!childType.toUpperCase().includes("BUILDINGSTOREY")) continue;
      const name =
        readIfcString(childLine.Name?.value) || `Storey ${childId}`;
      const elevation = numericOrZero(childLine.Elevation?.value);
      const guid = readIfcString(childLine.GlobalId?.value) || "";
      storeyMap.set(childId, {
        expressId: childId,
        name,
        elevation,
        height: null,
        guid,
        containedElementIds: [],
      });
    }
  }

  // --- IfcRelContainedInSpatialStructure (Task 22-amendment) ---
  // Map every storey expressId to the set of element expressIds
  // physically or logically contained in that storey. The Models-
  // tool Levels filter needs this to isolate or hide a level —
  // without it, the filter would only toggle the (typically
  // invisible) storey entity itself.
  //
  // Method: walk every IfcRelContainedInSpatialStructure row.
  // `RelatingStructure` is the storey (IfcSpatialStructureElement,
  // typically IfcBuildingStorey), `RelatedElements` is the SET of
  // contained IfcProduct instances (IfcWall, IfcSlab, IfcFooting,
  // etc.). We populate `storeyMap.get(structureId).containedElementIds`
  // from this walk.
  //
  // We do NOT walk IfcRelAggregates for the same purpose — that
  // relation is used for spatial hierarchy (building → storey)
  // not element containment. The two relations are distinct in
  // IFC. Some authoring tools emit only one of them; we cover
  // the IfcRelContainedInSpatialStructure case which is the more
  // common one in production BIM models.
  {
    const relContIds = ifc.GetLineIDsWithType(
      modelID,
      WEBIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE,
    );
    for (let i = 0; i < relContIds.size(); i++) {
      const rel = ifc.GetLine(modelID, relContIds.get(i), false);
      if (!rel) continue;
      const structRef = rel.RelatingStructure;
      const structureId =
        structRef && typeof structRef === "object" && "value" in structRef
          ? (structRef as { value: unknown }).value
          : structRef;
      if (typeof structureId !== "number") continue;
      const relatedElements = Array.isArray(rel.RelatedElements)
        ? rel.RelatedElements
        : [];
      const elementIds: number[] = [];
      for (const elRef of relatedElements) {
        const elId =
          elRef && typeof elRef === "object" && "value" in elRef
            ? (elRef as { value: unknown }).value
            : elRef;
        if (typeof elId === "number") elementIds.push(elId);
      }
      // Merge into the existing list if multiple rels target the
      // same storey (uncommon but valid in some IFC files).
      const storey = storeyMap.get(structureId);
      if (!storey) continue; // rel targets a non-storey spatial element
      const seen = new Set<number>(storey.containedElementIds);
      for (const id of elementIds) {
        if (!seen.has(id)) {
          seen.add(id);
          storey.containedElementIds.push(id);
        }
      }
    }
  }

  // --- Property catalog walk (Task 20C-Part 1 §2) ---
  // Walk IFCRELDEFINESBYPROPERTIES and pull every (pset, name)
  // pair. The RelatingPropertyDefinition can be either an
  // IfcPropertySet (has .HasProperties) or an IfcElementQuantity
  // (has .Quantities). We handle both with the same name pattern
  // — quantities are cataloged alongside properties so the
  // Qto_WallBaseQuantities rows show up under their natural pset
  // name.
  //
  // We don't branch on IfcPropertySingleValue vs other subtypes
  // (IfcPropertyEnumeratedValue, IfcPropertyBoundedValue, etc.)
  // — every subtype exposes `.Name`, and we only catalog names.
  const relIds = ifc.GetLineIDsWithType(
    modelID,
    WEBIFC.IFCRELDEFINESBYPROPERTIES,
  );
  // Memos (wave 61) — pure work-skipping, the emitted catalog (rows
  // AND order) is unchanged: authoring tools share pset instances
  // across many rels and property instances across many psets, and
  // every element shows up in several rels. GetLine() materialises a
  // JS object per call, which dominated this walk on large models.
  //   psetNameById : psetId -> Name ("" = unnamed / missing line)
  //   walkedPsets  : psets whose HasProperties/Quantities were walked
  //                  (a 2nd visit can only re-hit seen keys)
  //   lineNameById : property / quantity id -> Name
  //   classifiedEls: element ids already run through GetLineType
  const psetNameById = new Map<number, string>();
  const walkedPsets = new Set<number>();
  const lineNameById = new Map<number, string>();
  const classifiedEls = new Set<number>();
  const lineName = (id: number): string => {
    let n = lineNameById.get(id);
    if (n === undefined) {
      const line = ifc.GetLine(modelID, id, false);
      n = line ? readIfcString(line.Name?.value) : "";
      lineNameById.set(id, n);
    }
    return n;
  };

  for (let i = 0; i < relIds.size(); i++) {
    const rel = ifc.GetLine(modelID, relIds.get(i), false);
    if (!rel) continue;
    const psetRef = rel.RelatingPropertyDefinition;
    const psetId =
      psetRef && typeof psetRef === "object" && "value" in psetRef
        ? (psetRef as { value: unknown }).value
        : psetRef;
    if (typeof psetId !== "number") continue;
    let pset: ReturnType<WEBIFC.IfcAPI["GetLine"]> | null = null;
    let psetName = psetNameById.get(psetId);
    if (psetName === undefined) {
      pset = ifc.GetLine(modelID, psetId, false);
      psetName = pset ? readIfcString(pset.Name?.value) : "";
      psetNameById.set(psetId, psetName);
    }
    if (!psetName) continue;

    // Synthetic `_IfcClass` extraction (Task 20C-Part 2 §2).
    //
    // Each IFCRELDEFINESBYPROPERTIES row carries a list of
    // `RelatedObjects` — the IFC elements that the property set is
    // attached to. We use this side-walk to also collect each
    // element's IFC class name, building a synthetic
    // "_IfcClass" pset in the catalog so the CustomFilterBuilder's
    // autocomplete can offer entity-type filtering (e.g.
    // `_IfcClass equals IfcWall`).
    //
    // Method: web-ifc exposes IfcAPI.GetLineType(modelID, expressID)
    // which returns a numeric IFC type code; IfcAPI.GetNameFromTypeCode
    // resolves that code to the string name (`IFCWALL`,
    // `IFCDOOR`, etc.). Both are stable for a given web-ifc build
    // and don't require fetching the full element line.
    //
    // Limitation: this walk only visits elements that appear in
    // IFCRELDEFINESBYPROPERTIES. Elements with no property set
    // (rare in production BIM models) won't contribute a class
    // entry — accepted trade-off per spec.
    const relatedObjects = Array.isArray(rel.RelatedObjects)
      ? rel.RelatedObjects
      : [];
    for (const objRef of relatedObjects) {
      const elemId =
        objRef && typeof objRef === "object" && "value" in objRef
          ? (objRef as { value: unknown }).value
          : objRef;
      if (typeof elemId !== "number") continue;
      if (classifiedEls.has(elemId)) continue;
      classifiedEls.add(elemId);
      let className: string;
      try {
        const typeCode = ifc.GetLineType(modelID, elemId);
        if (typeof typeCode !== "number") continue;
        className = ifc.GetNameFromTypeCode(typeCode);
      } catch {
        continue;
      }
      if (!className || className === "IFCROOT") continue;
      if (classSeen.has(className)) continue;
      classSeen.add(className);
      propertyCatalog.push({
        fileId: catalogFileId,
        pset: "_IfcClass",
        name: className,
      });
    }

    // Same pset instance already walked: its (pset, name) keys are
    // all in catalogSeen, nothing new can come out of it.
    if (walkedPsets.has(psetId)) continue;
    walkedPsets.add(psetId);
    if (!pset) pset = ifc.GetLine(modelID, psetId, false);
    if (!pset) continue;

    // IfcPropertySet.HasProperties — walk all IfcProperty subtypes.
    // `GetLine(..., false)` skips Express-Entity expansion so we
    // get the raw handle; `.Name?.value` is the IfcLabel that
    // every property subtype exposes.
    const hasProperties = Array.isArray(pset.HasProperties)
      ? pset.HasProperties
      : [];
    for (const propRef of hasProperties) {
      const propId =
        propRef && typeof propRef === "object" && "value" in propRef
          ? (propRef as { value: unknown }).value
          : propRef;
      if (typeof propId !== "number") continue;
      const propName = lineName(propId);
      if (!propName) continue;
      const key = `${psetName}\x00${propName}`;
      if (catalogSeen.has(key)) continue;
      catalogSeen.add(key);
      propertyCatalog.push({
        fileId: catalogFileId,
        pset: psetName,
        name: propName,
      });
    }

    // IfcElementQuantity.Quantities — same Name pattern, same
    // pset object. Includes Qto_* quantity sets.
    const quantities = Array.isArray(pset.Quantities) ? pset.Quantities : [];
    for (const qtyRef of quantities) {
      const qtyId =
        qtyRef && typeof qtyRef === "object" && "value" in qtyRef
          ? (qtyRef as { value: unknown }).value
          : qtyRef;
      if (typeof qtyId !== "number") continue;
      const qtyName = lineName(qtyId);
      if (!qtyName) continue;
      const key = `${psetName}\x00${qtyName}`;
      if (catalogSeen.has(key)) continue;
      catalogSeen.add(key);
      propertyCatalog.push({
        fileId: catalogFileId,
        pset: psetName,
        name: qtyName,
      });
    }
  }

  return {
    schema,
    buildings,
    // Names are made unique per file ("Level 1", "Level 1 (2)"):
    // the storeys table has a unique [ifcVersionId+name] index.
    storeys: disambiguateStoreyNames(
      Array.from(storeyMap.values()).sort((a, b) => a.elevation - b.elevation),
    ),
    propertyCatalog,
  };
}

/**
 * Standalone parse: own IfcAPI, open, extract, close. One full parse
 * of the file — the import pipeline does NOT use this any more (it
 * extracts from the importer's own parse, see ./convertIfc.ts); kept
 * for tests and as the fallback when that hook can't attach.
 */
export async function parseIfc(bytes: Uint8Array): Promise<ParsedIfc> {
  const ifc = new WEBIFC.IfcAPI();
  setWebIfcWasmPath(ifc);
  await ifc.Init();
  const modelID = ifc.OpenModel(bytes, { COORDINATE_TO_ORIGIN: true });
  try {
    return extractIfcMetadata(ifc, modelID);
  } finally {
    ifc.CloseModel(modelID);
    ifc.Dispose();
  }
}

function readIfcString(v: unknown): string {
  if (typeof v === "string") return v;
  if (
    v &&
    typeof v === "object" &&
    "value" in (v as Record<string, unknown>)
  ) {
    const val = (v as { value: unknown }).value;
    if (typeof val === "string") return val;
  }
  return "";
}

function numericOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (
    v &&
    typeof v === "object" &&
    "value" in (v as Record<string, unknown>)
  ) {
    const val = (v as { value: unknown }).value;
    if (typeof val === "number" && Number.isFinite(val)) return val;
  }
  return 0;
}
