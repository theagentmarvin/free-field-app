/**
 * Typed refs for the Phase 1c synced collections (docs/SPEC-PHASE-1.md §4).
 * Flat collections under the project, one per Dexie table.
 * `buildingsCollection` / `foldersCollection` live in ./collections.
 */

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
} from 'firebase/firestore';

import type {
  IfcFile,
  IfcVersion,
  Storey,
  ExtractedStorey,
  PdfFile,
  PdfVersion,
  Calibration,
  FolderAssignment,
  Viewpoint,
  PlanMarkup,
} from '../schema/sync';
import { calibrationDocId, folderAssignmentDocId } from '../schema/sync';

/** Collection name -> doc type, for every synced collection. */
export interface SyncedCollectionDocs {
  buildings: import('../schema/building').Building;
  ifcFiles: IfcFile;
  ifcVersions: IfcVersion;
  storeys: Storey;
  extractedStoreys: ExtractedStorey;
  pdfFiles: PdfFile;
  pdfVersions: PdfVersion;
  calibrations: Calibration;
  folders: import('../schema/folder').Folder;
  folderAssignments: FolderAssignment;
  viewpoints: Viewpoint;
  planMarkups: PlanMarkup;
}

export type SyncedCollectionName = keyof SyncedCollectionDocs;

export const SYNCED_COLLECTIONS: readonly SyncedCollectionName[] = [
  'buildings',
  'ifcFiles',
  'ifcVersions',
  'storeys',
  'extractedStoreys',
  'pdfFiles',
  'pdfVersions',
  'calibrations',
  'folders',
  'folderAssignments',
  'viewpoints',
  'planMarkups',
];

/** Generic typed collection ref: `syncedCollection(db, pid, 'storeys')`. */
export function syncedCollection<N extends SyncedCollectionName>(
  db: Firestore,
  projectId: string,
  name: N,
): CollectionReference<SyncedCollectionDocs[N]> {
  return collection(db, 'projects', projectId, name) as CollectionReference<
    SyncedCollectionDocs[N]
  >;
}

export function syncedDoc<N extends SyncedCollectionName>(
  db: Firestore,
  projectId: string,
  name: N,
  docId: string,
): DocumentReference<SyncedCollectionDocs[N]> {
  return doc(db, 'projects', projectId, name, docId) as DocumentReference<
    SyncedCollectionDocs[N]
  >;
}

export const ifcFilesCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'ifcFiles');
export const ifcVersionsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'ifcVersions');
export const storeysCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'storeys');
export const extractedStoreysCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'extractedStoreys');
export const pdfFilesCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'pdfFiles');
export const pdfVersionsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'pdfVersions');
export const calibrationsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'calibrations');
export const folderAssignmentsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'folderAssignments');
export const viewpointsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'viewpoints');

export const planMarkupsCollection = (db: Firestore, pid: string) =>
  syncedCollection(db, pid, 'planMarkups');

export const calibrationDoc = (
  db: Firestore,
  pid: string,
  pdfFileId: string,
  storeyName: string,
) => syncedDoc(db, pid, 'calibrations', calibrationDocId(pdfFileId, storeyName));

export const folderAssignmentDoc = (db: Firestore, pid: string, pdfFileId: string) =>
  syncedDoc(db, pid, 'folderAssignments', folderAssignmentDocId(pdfFileId));
