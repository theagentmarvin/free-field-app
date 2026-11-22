/**
 * Cloud Storage object paths for synced blobs (docs/SPEC-PHASE-1.md §4, 1d).
 * Objects are immutable (create-only) and named by the version doc id, so a
 * path can be derived from the version doc alone. Keep in sync with
 * repo-root storage.rules and the path checks in firestore.rules.
 */

export type BlobKind = 'ifc' | 'frag' | 'pdf';

export const BLOB_EXTENSION: Record<BlobKind, string> = {
  ifc: 'ifc',
  frag: 'frag',
  pdf: 'pdf',
};

/** Size caps enforced by storage.rules, in bytes. */
export const BLOB_MAX_BYTES: Record<BlobKind, number> = {
  pdf: 200 * 1024 * 1024,
  frag: 500 * 1024 * 1024,
  ifc: 1024 * 1024 * 1024,
};

/** Content types enforced by storage.rules. */
export const BLOB_CONTENT_TYPES: Record<BlobKind, readonly string[]> = {
  pdf: ['application/pdf'],
  frag: ['application/octet-stream'],
  ifc: ['application/octet-stream'],
};

export function blobStoragePath(
  projectId: string,
  kind: BlobKind,
  versionId: string,
): string {
  return `projects/${projectId}/${kind}/${versionId}.${BLOB_EXTENSION[kind]}`;
}

export const ifcStoragePath = (pid: string, versionId: string) =>
  blobStoragePath(pid, 'ifc', versionId);
export const fragStoragePath = (pid: string, versionId: string) =>
  blobStoragePath(pid, 'frag', versionId);
export const pdfStoragePath = (pid: string, versionId: string) =>
  blobStoragePath(pid, 'pdf', versionId);
