/**
 * Compile-time parity check (run by `pnpm typecheck`, no runtime): every
 * field of each Dexie row type in @ff/types (except the epoch-ms
 * `updatedAt`, which the server-stamped base replaces) exists, with the same
 * type, on the matching Firestore doc type, so one adapter can map row <-> doc.
 */
import type {
  BuildingRecord,
  IfcFileRecord,
  IfcVersionRecord,
  StoreyRecord,
  ExtractedStoreyRecord,
  PdfFileRecord,
  PdfVersionRecord,
  CalibrationRecord,
  PdfFolderRecord,
  PdfFolderAssignmentRecord,
  ViewerViewpointRecord,
  PlanMarkupRecord,
} from '@ff/types';
import type {
  Building,
  IfcFile,
  IfcVersion,
  Storey,
  ExtractedStorey,
  PdfFile,
  PdfVersion,
  Calibration,
  Folder,
  FolderAssignment,
  Viewpoint,
  PlanMarkup,
} from '../src';

// `remoteUpdatedAt` is the local mirror of the server stamp; the optional blob
// reference fields are filled by the sync engine (Required<> checks their types).
type RowFields<R> = Required<Omit<R, 'updatedAt' | 'remoteUpdatedAt'>>;
/** Resolves to `true` only when every row field is present on the doc, same type. */
type Covers<Doc, Row> = false extends {
  [K in keyof RowFields<Row>]: K extends keyof Doc
    ? [Doc[K]] extends [RowFields<Row>[K]]
      ? [RowFields<Row>[K]] extends [Doc[K]]
        ? true
        : false
      : false
    : false;
}[keyof RowFields<Row>]
  ? false
  : true;

type Assert<T extends true> = T;

export type _Parity = [
  Assert<Covers<Building, BuildingRecord>>,
  Assert<Covers<IfcFile, IfcFileRecord>>,
  Assert<Covers<IfcVersion, IfcVersionRecord>>,
  Assert<Covers<Storey, StoreyRecord>>,
  Assert<Covers<ExtractedStorey, ExtractedStoreyRecord>>,
  Assert<Covers<PdfFile, PdfFileRecord>>,
  // PdfVersionRecord.size is the same number as the doc's size / sizeBytes.
  Assert<Covers<PdfVersion, PdfVersionRecord>>,
  Assert<Covers<Calibration, CalibrationRecord>>,
  Assert<Covers<Folder, PdfFolderRecord>>,
  Assert<Covers<FolderAssignment, PdfFolderAssignmentRecord>>,
  Assert<Covers<Viewpoint, ViewerViewpointRecord>>,
  Assert<Covers<PlanMarkup, PlanMarkupRecord>>,
];
