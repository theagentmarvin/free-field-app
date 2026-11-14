// packages/ff-viewer-tools/src/components/groupElementProperties.ts
//
// Group the flat `getElementData` record (`PsetName.PropertyName` keys
// plus bare entity attributes) into pset → [property, value] rows for
// the PropertiesDrawer.
//
// Wave 63: the flat key is ambiguous when a pset or property name
// contains "." — the old first-dot split filed `Pset 1.2.FireRating`
// under pset "Pset 1". Records from the viewer carry the real grouping
// (`getPropertyGroups`); the first-dot split is only the fallback for
// records without it.

import { getPropertyGroups } from "@ff/viewer-react";

export function groupElementProperties(
  elementData: Record<string, string> | null,
): Map<string, Array<[string, string]>> {
  const byPset = new Map<string, Array<[string, string]>>();
  if (!elementData) return byPset;

  const groups = getPropertyGroups(elementData);
  if (groups) {
    const psetKeys = new Set<string>();
    for (const g of groups) {
      for (const [prop] of g.properties) psetKeys.add(`${g.pset}.${prop}`);
    }
    const entity: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(elementData)) {
      if (!psetKeys.has(key)) entity.push([key, value]);
    }
    if (entity.length > 0) byPset.set("IFC Entity", entity);
    for (const g of groups) {
      const rows = byPset.get(g.pset) ?? [];
      rows.push(...g.properties);
      byPset.set(g.pset, rows);
    }
    return byPset;
  }

  for (const [key, value] of Object.entries(elementData)) {
    // Keys are like "Pset_WallCommon.FireRating" or just "Name".
    const dotIdx = key.indexOf(".");
    if (dotIdx === -1) {
      // Top-level attribute like "Name", "GlobalId", etc.
      const set = byPset.get("IFC Entity") ?? [];
      set.push([key, value]);
      byPset.set("IFC Entity", set);
    } else {
      const pset = key.substring(0, dotIdx);
      const prop = key.substring(dotIdx + 1);
      const set = byPset.get(pset) ?? [];
      set.push([prop, value]);
      byPset.set(pset, set);
    }
  }
  return byPset;
}
