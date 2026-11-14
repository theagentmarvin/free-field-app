// src/ifc/storeyNames.ts
//
// Storey names must be unique per IFC version: the Dexie `storeys`
// table has a unique `&[ifcVersionId+name]` index, and calibrations /
// level selection key on the name. Real IFC files do repeat names
// (two "Level 1" storeys from a copy-pasted level, or several unnamed
// ones), which made `bulkAdd` throw and the whole import fail.
//
// `disambiguateStoreyNames` keeps the first occurrence (in the given
// order — extraction sorts by elevation, so the lowest keeps its
// name) and suffixes later ones " (2)", " (3)", ... skipping any
// suffix that is itself already a real storey name.

export function disambiguateStoreyNames<T extends { name: string }>(
  storeys: readonly T[],
): T[] {
  const taken = new Set<string>(storeys.map((s) => s.name));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const s of storeys) {
    if (!seen.has(s.name)) {
      seen.add(s.name);
      out.push(s);
      continue;
    }
    let n = 2;
    let candidate = `${s.name} (${n})`;
    while (taken.has(candidate) || seen.has(candidate)) {
      n++;
      candidate = `${s.name} (${n})`;
    }
    seen.add(candidate);
    taken.add(candidate);
    out.push({ ...s, name: candidate });
  }
  return out;
}
