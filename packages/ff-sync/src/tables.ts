/**
 * Per-table sync configuration: the ONE generic adapter (adapter.ts) maps a
 * Dexie row <-> Firestore doc using these entries. Field names are identical
 * between row and doc (see docs/integration/w70-sync-contracts.md); the
 * differences are listed per table.
 */

import type { z } from "zod";
import {
  BuildingSchema,
  CalibrationSchema,
  ExtractedStoreySchema,
  FolderAssignmentSchema,
  FolderSchema,
  IfcFileSchema,
  IfcVersionSchema,
  PdfFileSchema,
  PdfVersionSchema,
  StoreySchema,
  ViewpointSchema,
  calibrationDocId,
  folderAssignmentDocId,
} from "@ff/firestore";
import type { ProjectDatabase } from "@ff/data/db/database";

import type { SyncCollectionName } from "./types";


// Rows are structurally typed per table by Dexie; the generic adapter treats them as bags of fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = any;

/** Keys the server owns on every doc. */
export const BASE_KEYS = ["updatedAt", "updatedBy", "deletedAt", "schema"] as const;

/** Rules cap `containedElementIds` at this many ids; longer lists are sent empty. */
export const MAX_CONTAINED_IDS = 100_000;

export interface TableConfig {
  collection: SyncCollectionName;
  /** Dexie table name. */
  table:
    | "buildings"
    | "ifcFiles"
    | "ifcVersions"
    | "storeys"
    | "extractedStoreys"
    | "pdfFiles"
    | "pdfVersions"
    | "calibrations"
    | "pdfFolders"
    | "pdfFolderAssignments"
    | "viewerViewpoints";
  /** Doc schema WITHOUT the base keys (validates both directions). */
  schema: z.ZodObject<z.ZodRawShape>;
  /** Firestore doc id of a local row. */
  docId(row: Row): string;
  /** Fields applied on top of the row when building a doc (defaults for absent optionals). */
  defaults?: Record<string, unknown>;
  /** Extra row -> doc shaping (runs after defaults). */
  shapeDoc?(row: Row, doc: Record<string, unknown>): void;
  /** The local row table keeps its own epoch-ms `updatedAt` (mirrors the server stamp). */
  hasUpdatedAt: boolean;
  /** Find the local row a remote doc should replace (default: by primary key = doc id). */
  findLocal?(db: ProjectDatabase, docId: string, data: Record<string, unknown>): Promise<Row | undefined>;
  /** Local primary key to use when no local row exists yet. */
  newLocalId?(docId: string, data: Record<string, unknown>): string;
  /** Unique-index guard for incoming rows (see adapter `applyChanges`). */
  unique?: UniqueGuard;
  /**
   * Deterministic-id tables: two devices can create the same doc, and the
   * rules make these fields immutable once it exists, so the drain copies
   * them from the existing server doc before writing.
   */
  keepFromRemote?: string[];
  /** Blob family hanging off this table (version tables only). */
  blob?: { kind: "pdf" | "frag"; keyField: string };
  /** Parent field + version field for drain-time `versionNumber` allocation. */
  versioned?: { parentField: string };
  /** Publish order (parents first). */
  order: number;
}

export interface UniqueGuard {
  index: string;
  /** Values of the compound index for a row. */
  values(row: Row): unknown[];
  /** `rename`: suffix `nameField` until free. `skip`: drop the incoming row. */
  onConflict: "rename" | "skip";
  nameField?: string;
}

const strip = (s: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> =>
  s.omit({ updatedAt: true, updatedBy: true, deletedAt: true, schema: true } as never) as never;

const idOf = (row: Row): string => String(row.id);

export const TABLES: readonly TableConfig[] = [
  {
    collection: "buildings",
    table: "buildings",
    schema: strip(BuildingSchema as never),
    docId: idOf,
    hasUpdatedAt: true,
    unique: {
      index: "[projectId+name]",
      values: (r) => [r.projectId, r.name],
      onConflict: "rename",
      nameField: "name",
    },
    order: 0,
  },
  {
    collection: "folders",
    table: "pdfFolders",
    schema: strip(FolderSchema as never),
    docId: idOf,
    hasUpdatedAt: true,
    order: 1,
  },
  {
    collection: "ifcFiles",
    table: "ifcFiles",
    schema: strip(IfcFileSchema as never),
    docId: idOf,
    hasUpdatedAt: true,
    unique: {
      index: "[buildingId+name]",
      values: (r) => [r.buildingId, r.name],
      onConflict: "rename",
      nameField: "name",
    },
    order: 2,
  },
  {
    collection: "pdfFiles",
    table: "pdfFiles",
    schema: strip(PdfFileSchema as never),
    docId: idOf,
    hasUpdatedAt: true,
    unique: {
      index: "[buildingId+name]",
      values: (r) => [r.buildingId, r.name],
      onConflict: "rename",
      nameField: "name",
    },
    order: 3,
  },
  {
    collection: "ifcVersions",
    table: "ifcVersions",
    schema: strip(IfcVersionSchema as never),
    docId: idOf,
    defaults: {
      storagePath: null,
      sha256: null,
      sizeBytes: null,
      contentType: null,
      fragStoragePath: null,
      fragSha256: null,
      fragSizeBytes: null,
    },
    hasUpdatedAt: false,
    unique: {
      index: "[ifcFileId+versionNumber]",
      values: (r) => [r.ifcFileId, r.versionNumber],
      onConflict: "skip",
    },
    blob: { kind: "frag", keyField: "fragBlobKey" },
    versioned: { parentField: "ifcFileId" },
    order: 4,
  },
  {
    collection: "pdfVersions",
    table: "pdfVersions",
    schema: strip(PdfVersionSchema as never),
    docId: idOf,
    shapeDoc(row, doc) {
      // `size` (Dexie) and `sizeBytes` (blob contract) carry the same number.
      if (doc.sizeBytes == null) doc.sizeBytes = row.size;
      if (doc.contentType == null) doc.contentType = "application/pdf";
    },
    hasUpdatedAt: false,
    unique: {
      index: "[pdfFileId+versionNumber]",
      values: (r) => [r.pdfFileId, r.versionNumber],
      onConflict: "skip",
    },
    blob: { kind: "pdf", keyField: "blobKey" },
    versioned: { parentField: "pdfFileId" },
    order: 5,
  },
  {
    collection: "storeys",
    table: "storeys",
    schema: strip(StoreySchema as never),
    docId: idOf,
    shapeDoc(_row, doc) {
      const ids = doc.containedElementIds;
      if (Array.isArray(ids) && ids.length > MAX_CONTAINED_IDS) doc.containedElementIds = [];
    },
    hasUpdatedAt: false,
    unique: {
      index: "[ifcVersionId+name]",
      values: (r) => [r.ifcVersionId, r.name],
      onConflict: "rename",
      nameField: "name",
    },
    order: 6,
  },
  {
    collection: "extractedStoreys",
    table: "extractedStoreys",
    schema: strip(ExtractedStoreySchema as never),
    docId: idOf,
    hasUpdatedAt: true,
    unique: {
      index: "[buildingId+storeyId]",
      values: (r) => [r.buildingId, r.storeyId],
      onConflict: "skip",
    },
    order: 7,
  },
  {
    collection: "calibrations",
    table: "calibrations",
    schema: strip(CalibrationSchema as never),
    // Deterministic id: two devices calibrating one (pdf, storey) pair
    // converge on one doc. The local row keeps its own uuid.
    docId: (r) => calibrationDocId(String(r.pdfFileId), String(r.storeyName)),
    hasUpdatedAt: true,
    keepFromRemote: ["createdAt"],
    findLocal: async (db, _docId, data) =>
      (await db.calibrations
        .where("[pdfFileId+storeyName]")
        .equals([String(data.pdfFileId), String(data.storeyName)])
        .first()) as Row | undefined,
    order: 8,
  },
  {
    collection: "folderAssignments",
    table: "pdfFolderAssignments",
    schema: strip(FolderAssignmentSchema as never),
    // Doc id = pdfFileId (one folder per PDF). New local rows use it as id.
    docId: (r) => folderAssignmentDocId(String(r.pdfFileId)),
    hasUpdatedAt: false,
    keepFromRemote: ["createdAt"],
    findLocal: async (db, docId) =>
      (await db.pdfFolderAssignments.where("pdfFileId").equals(docId).first()) as Row | undefined,
    newLocalId: (docId) => docId,
    order: 9,
  },
  {
    collection: "viewpoints",
    table: "viewerViewpoints",
    schema: strip(ViewpointSchema as never),
    docId: idOf,
    hasUpdatedAt: false,
    order: 10,
  },
];

export const TABLE_BY_COLLECTION: Readonly<Record<SyncCollectionName, TableConfig>> =
  Object.fromEntries(TABLES.map((t) => [t.collection, t])) as never;

export const TABLE_BY_DEXIE_NAME: Readonly<Record<string, TableConfig>> = Object.fromEntries(
  TABLES.map((t) => [t.table, t]),
);
