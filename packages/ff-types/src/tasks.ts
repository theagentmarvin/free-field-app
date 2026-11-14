// Dexie v9 records — task module (plan 2026-11-01 §2.4, task-39).
//
// The whole client-side data-plane borrowing for cloud-first: an
// offline write queue (`outbox`) and crash-recovery compose state
// (`drafts`). Reads are NOT mirrored — Firestore's own persistence
// cache (initFirestore) serves warm reads.

/** Outbox row states (plan §4). `killed` is the delete-sheet tombstone. */
export type OutboxState = "added" | "sending" | "sent" | "failed" | "killed";

/** Photo blob references carried with a queued action (keys into the
 *  blob store / in-memory map; resolved to TaskPhoto metadata on upload). */
export interface OutboxPhotoRef {
  blobKey: string;
  sha256: string; // 64-hex, computed client-side (WebCrypto)
  size: number;
  mime: string;
}

/**
 * A queued task action. The engine (ff-tasks) drives state:
 *   added → sending → sent | failed (attempts ≥ 3) | killed
 * `clientGuid` is the timeline-entry doc id — the idempotency key
 * that makes a retried transaction a no-op (rules enforce the
 * docId == clientGuid equality).
 */
export interface OutboxRecord {
  id: string; // uuid (row id)
  kind: "task-action"; // single kind v1; index kept for future kinds
  state: OutboxState;
  projectId: string;
  payload: Record<string, unknown>; // TaskActionPayload (ff-tasks owns the shape)
  photoRefs: OutboxPhotoRef[];
  attempts: number;
  lastError?: string;
  clientGuid: string;
  resultTaskId?: string; // echoed after a successful commit
  createdAt: number;
  sentAt?: number;
}

/**
 * Half-composed task, auto-snapshotted (15 s cadence while dirty,
 * Day-3 UI) for crash recovery. `draft` is a TaskDraftFields JSON —
 * never sent to the cloud; only the completed action enters the outbox.
 */
export interface TaskDraftRecord {
  id: string; // taskId (client uuid, allocated at compose start)
  projectId: string;
  updatedAt: number;
  draft: Record<string, unknown>;
}
