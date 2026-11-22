import { z } from 'zod';
import { FirestoreTimestampSchema } from './timestamp';

/**
 * Shared base for every Phase 1c/1d synced doc (docs/SPEC-PHASE-1.md §4):
 *
 *  - `updatedAt`  server Timestamp (rules: == request.time). It replaces the
 *                 Dexie row's epoch-ms `updatedAt`; the sync adapter stores it
 *                 locally as `remoteUpdatedAt`.
 *  - `updatedBy`  uid of the writer (rules: == request.auth.uid).
 *  - `deletedAt`  tombstone: `null` while live, a server Timestamp once
 *                 deleted. Members never hard-delete (offline peers must learn
 *                 about deletions); a scheduled function garbage-collects
 *                 tombstones after 30 days.
 *  - `schema`     contract version, always `1` for now.
 *
 * All other field names are IDENTICAL to the Dexie row types in `@ff/types`
 * so one adapter maps row <-> doc by dropping `updatedAt` and adding the base.
 * Every field is required (nullable where a value may be absent) so the rules
 * can pin the exact key set (`hasOnly` + `hasAll`).
 */
export const SYNC_SCHEMA_VERSION = 1 as const;

export const SyncBaseSchema = z.object({
  updatedAt: FirestoreTimestampSchema,
  updatedBy: z.string().min(1),
  deletedAt: FirestoreTimestampSchema.nullable(),
  schema: z.literal(SYNC_SCHEMA_VERSION),
});

export type SyncBase = z.infer<typeof SyncBaseSchema>;

/** Fields of a blob-backed (version) doc. */
export const BlobFields = {
  /** `projects/{pid}/<kind>/{versionId}.<ext>` */
  storagePath: z.string().min(1),
  /** Full-content SHA-256, 64 lowercase hex chars. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
};
