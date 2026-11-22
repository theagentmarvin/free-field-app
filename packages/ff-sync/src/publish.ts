/**
 * First-upload helpers (spec §7 step 2): find the rows of a project that
 * exist only locally and enqueue them. Parents come before children.
 */

import type { ProjectDatabase } from "@ff/data/db/database";

import { TABLES, type Row, type TableConfig } from "./tables";

/** Local rows of the project, per table config (scoped through the building tree). */
export async function projectRows(
  db: ProjectDatabase,
  projectId: string,
): Promise<Map<TableConfig, Row[]>> {
  const out = new Map<TableConfig, Row[]>();
  const byName = new Map(TABLES.map((t) => [t.table, t]));
  const get = (n: string) => byName.get(n as never)!;

  const buildings = (await db.buildings.where("projectId").equals(projectId).toArray()) as Row[];
  const bIds = buildings.map((b) => String(b.id));
  const byBuilding = async (table: string): Promise<Row[]> =>
    bIds.length ? ((await db.table(table).where("buildingId").anyOf(bIds).toArray()) as Row[]) : [];

  const ifcFiles = await byBuilding("ifcFiles");
  const pdfFiles = await byBuilding("pdfFiles");
  const ifcIds = ifcFiles.map((f) => String(f.id));
  const pdfIds = pdfFiles.map((f) => String(f.id));

  out.set(get("buildings"), buildings);
  out.set(get("pdfFolders"), (await db.pdfFolders.where("projectId").equals(projectId).toArray()) as Row[]);
  out.set(get("ifcFiles"), ifcFiles);
  out.set(get("pdfFiles"), pdfFiles);
  out.set(
    get("ifcVersions"),
    ifcIds.length ? ((await db.ifcVersions.where("ifcFileId").anyOf(ifcIds).toArray()) as Row[]) : [],
  );
  out.set(
    get("pdfVersions"),
    pdfIds.length ? ((await db.pdfVersions.where("pdfFileId").anyOf(pdfIds).toArray()) as Row[]) : [],
  );
  out.set(get("storeys"), await byBuilding("storeys"));
  out.set(get("extractedStoreys"), await byBuilding("extractedStoreys"));
  out.set(get("calibrations"), (await db.calibrations.where("projectId").equals(projectId).toArray()) as Row[]);
  out.set(
    get("pdfFolderAssignments"),
    pdfIds.length ? ((await db.pdfFolderAssignments.where("pdfFileId").anyOf(pdfIds).toArray()) as Row[]) : [],
  );
  out.set(
    get("viewerViewpoints"),
    (await db.viewerViewpoints.where("projectId").equals(projectId).toArray()) as Row[],
  );
  return out;
}

export interface LocalOnlySummary {
  /** Local-only buildings (what the prompt names). */
  buildings: number;
  /** Local-only rows across every synced table. */
  rows: number;
}

export async function countLocalOnly(db: ProjectDatabase, projectId: string): Promise<LocalOnlySummary> {
  let rows = 0;
  let buildings = 0;
  for (const [cfg, list] of await projectRows(db, projectId)) {
    const n = list.filter((r) => r.remoteUpdatedAt == null).length;
    rows += n;
    if (cfg.collection === "buildings") buildings = n;
  }
  return { buildings, rows };
}

/** Does this row belong to `projectId`? (cheap parent walk; used by the write hooks) */
export async function rowBelongsToProject(
  db: ProjectDatabase,
  cfg: TableConfig,
  row: Row,
  projectId: string,
): Promise<boolean> {
  if (typeof row.projectId === "string") return row.projectId === projectId;
  const buildingOf = async (buildingId: unknown): Promise<boolean> => {
    if (typeof buildingId !== "string") return false;
    return (await db.buildings.get(buildingId))?.projectId === projectId;
  };
  if (typeof row.buildingId === "string") return buildingOf(row.buildingId);
  if (typeof row.ifcFileId === "string") {
    return buildingOf((await db.ifcFiles.get(row.ifcFileId))?.buildingId);
  }
  if (typeof row.pdfFileId === "string") {
    return buildingOf((await db.pdfFiles.get(row.pdfFileId))?.buildingId);
  }
  void cfg;
  return false;
}
