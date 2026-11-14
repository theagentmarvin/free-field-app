// src/core/types/levelSelection.ts
//
// Dexie v2 record for the "is this storey checked in the Get Levels
// popover for this building?" mapping. The default for a (building,
// storey) pair with no row is `selected = true` — see
// docs/TASK-3-UI.md "Data model additions" and the `getEffectiveSelection`
// helper in src/hooks/useLevelSelection.ts.

/** Per-building record: "is this storey in the user's mapped set?". */
export interface BuildingLevelSelectionRecord {
  buildingId: string;   // FK (also part of composite key)
  levelId: string;      // FK → StoreyRecord.id (also part of composite key)
  selected: boolean;
  updatedAt: number;
}
