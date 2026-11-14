import type { OutboxRecord, OutboxState } from "@ff/types";

import type { TaskActionPayload } from "./action";

/**
 * Offline write queue engine (plan §4). Pure state machine over an
 * injected store + clock so the retry/backoff behaviour is unit-testable
 * without Dexie or timers. The Dexie-backed adapter lives in `local.ts`.
 */

export const BACKOFF_MS: readonly [number, number, number] = [1000, 5000, 20000];
export const MAX_ATTEMPTS = 3;
export const SENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface OutboxStore {
  add(row: OutboxRecord): Promise<void>;
  put(row: OutboxRecord): Promise<void>;
  get(id: string): Promise<OutboxRecord | undefined>;
  /** oldest-first, restricted to these states */
  next(states: readonly OutboxState[]): Promise<OutboxRecord | undefined>;
  /** Every row in these states, oldest-first. Enables per-task
   *  ordering, network-failure revival and pruning; without it the
   *  engine falls back to plain oldest-first `next()`. */
  list?(states: readonly OutboxState[]): Promise<OutboxRecord[]>;
  /** Hard delete (pruning). Without it, pruning only tombstones. */
  delete?(id: string): Promise<void>;
}

// ── Error classes ──────────────────────────────────────────────────

/**
 * - `network`: the request never reached the backend (offline, DNS,
 *   fetch failure, Firestore `unavailable`). Revived on `online`.
 * - `fatal`: retrying the same payload cannot succeed (permission,
 *   validation, missing photo bytes). Fails at once.
 * - `transient`: anything else — the normal backoff ladder.
 */
export type OutboxErrorClass = "network" | "fatal" | "transient";

const NETWORK_CODES = new Set([
  "unavailable",
  "deadline-exceeded",
  "storage/retry-limit-exceeded",
  "auth/network-request-failed",
]);
const FATAL_CODES = new Set([
  "permission-denied",
  "invalid-argument",
  "not-found",
  "already-exists",
  "failed-precondition",
  "out-of-range",
  "unimplemented",
  "data-loss",
  "unauthenticated",
  "storage/unauthorized",
  "storage/unauthenticated",
  "storage/invalid-argument",
  "storage/object-not-found",
  "storage/invalid-checksum",
  "storage/quota-exceeded",
]);
const NETWORK_TEXT =
  /\b(offline|network|failed to fetch|load failed|err_internet_disconnected|err_network)\b/i;
const FATAL_TEXT = /^blob-lost:/;

function errorCode(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/**
 * Text persisted as `lastError`: the Firebase error code (when there
 * is one) in brackets, then the message, so the class can be
 * recovered from the stored row later (`classifyOutboxError(string)`).
 */
export function describeOutboxError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const code = errorCode(err);
  return code && !message.startsWith(`[${code}]`) ? `[${code}] ${message}` : message;
}

/** Classify a thrown error, or a stored `lastError` string. */
export function classifyOutboxError(err: unknown): OutboxErrorClass {
  let code = typeof err === "string" ? null : errorCode(err);
  const text = typeof err === "string" ? err : err instanceof Error ? err.message : String(err);
  if (!code) {
    const m = /^\[([^\]]+)\]/.exec(text);
    if (m) code = m[1];
  }
  if (code && FATAL_CODES.has(code)) return "fatal";
  if (code && NETWORK_CODES.has(code)) return "network";
  if (FATAL_TEXT.test(text)) return "fatal";
  if (err instanceof TypeError && /fetch/i.test(text)) return "network";
  if (NETWORK_TEXT.test(text)) return "network";
  return "transient";
}

/** Rows that still have work to do (or block later rows of a task). */
export const ACTIVE_OUTBOX_STATES: readonly OutboxState[] = ["added", "sending", "failed"];

export interface OutboxExecutor {
  /** uploads payload.photoRefs → Storage, resolving sha-existing skips;
   *  runs BEFORE the transaction (binary-first ordering, plan §3) */
  uploadPhotos(row: OutboxRecord): Promise<void>;
  /** one Firestore transaction; retried as-is — idempotent via clientGuid */
  commit(row: OutboxRecord): Promise<{ taskId: string } | void>;
}

export interface OutboxClock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** jitter source, 0..1 */
  random(): number;
}

/**
 * Minimal transition record handed to the observer hook (spec §7 U6 —
 * "outbox + route breadcrumb sources").
 *
 * Deliberately shape-minimal: uuid + kind + state ONLY. Never the
 * payload, never a content id (no taskId, no projectId, no photo
 * refs, no error text) — the record is breadcrumb-safe by
 * construction, per the spec's "uuid/kind only" rule (§4.2 / §6).
 */
export interface OutboxTransition {
  /** Row uuid (== `clientGuid`). */
  uuid: string;
  /** Row kind ("task-action" in v1). */
  kind: OutboxRecord["kind"];
  /** The state the row just entered. */
  state: OutboxState;
}

export interface OutboxEngineOptions {
  store: OutboxStore;
  executor: OutboxExecutor;
  clock: OutboxClock;
  /** retry hook: called when a `failed` row is retried via retryNow */
  onStateChange?: (row: OutboxRecord) => void;
  /**
   * Transition observer (spec §7 U6). Called on EVERY state
   * transition — `added` / `sending` / `sent` / `failed` / `killed`
   * — with a minimal `{ uuid, kind, state }` record; the payload is
   * NEVER handed over.
   *
   * Optional and behavior-preserving: when omitted (the default) the
   * observer costs nothing and the engine behaves exactly as before.
   * A throwing observer is swallowed so it can never break the outbox
   * state machine.
   */
  onTransition?: (transition: OutboxTransition) => void;
  /**
   * Connectivity probe (default: always online). While offline the
   * drain stops, and a failure does not count against MAX_ATTEMPTS:
   * the row goes back to `added` for the next `online` event.
   */
  isOnline?: () => boolean;
}

export class OutboxEngine {
  private opts: OutboxEngineOptions;
  private draining = false;
  private scheduled = new Map<string, unknown>();

  constructor(opts: OutboxEngineOptions) {
    this.opts = opts;
  }

  /** Enqueue a freshly built payload; returns the row id. */
  async enqueue(payload: TaskActionPayload): Promise<OutboxRecord> {
    const row: OutboxRecord = {
      id: payload.clientGuid,
      kind: "task-action",
      state: "added",
      projectId: payload.projectId,
      payload: payload as unknown as Record<string, unknown>,
      photoRefs: payload.photoRefs,
      attempts: 0,
      clientGuid: payload.clientGuid,
      createdAt: this.opts.clock.now(),
    };
    await this.opts.store.add(row);
    this.notify(row);
    this.transition(row); // added
    void this.drain();
    return row;
  }

  /**
   * Serially processes `added` rows, oldest first, but IN ORDER PER
   * TASK: a row waits while an earlier row of the same task is still
   * unsent (backing off in `sending`, or `failed` awaiting retry or
   * delete), so a status change can never land before the create or
   * the comment queued ahead of it. Transient failures re-arm with
   * backoff[attempts] + jitter; after MAX_ATTEMPTS the row becomes
   * `failed` (red ⚠ badge, manual retry/delete via retryNow/remove).
   * Fatal errors fail at once. Nothing runs while offline.
   */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        if (!this.isOnline()) break;
        const row = await this.pickNext();
        if (!row) break;
        await this.process(row);
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * `online` handler: rows that failed only because the network was
   * down go back to `added` with fresh attempts, then the queue
   * drains. Fatal and other failures stay failed for the user.
   */
  async reviveNetworkFailed(): Promise<number> {
    const { store } = this.opts;
    let revived = 0;
    if (store.list) {
      for (const row of await store.list(["failed"])) {
        if (classifyOutboxError(row.lastError ?? "") !== "network") continue;
        row.state = "added";
        row.attempts = 0;
        await store.put(row);
        this.notify(row);
        this.transition(row); // failed → added (network revival)
        revived += 1;
      }
    }
    void this.drain();
    return revived;
  }

  private isOnline(): boolean {
    try {
      return this.opts.isOnline ? this.opts.isOnline() : true;
    } catch {
      return true;
    }
  }

  private async pickNext(): Promise<OutboxRecord | undefined> {
    const { store } = this.opts;
    if (!store.list) return store.next(["added"]);
    const rows = await store.list(ACTIVE_OUTBOX_STATES);
    const blocked = new Set<string>();
    for (const row of rows) {
      const taskId = (row.payload as { taskId?: unknown } | undefined)?.taskId;
      const key = typeof taskId === "string" ? taskId : null;
      if (row.state === "added" && (key === null || !blocked.has(key))) return row;
      if (key !== null) blocked.add(key);
    }
    return undefined;
  }

  /** Manual retry-now from the failed-row sheet: zero attempts, re-drain. */
  async retryNow(id: string): Promise<void> {
    const row = await this.opts.store.get(id);
    if (!row || row.state !== "failed") return;
    row.state = "added";
    row.attempts = 0;
    delete row.lastError;
    await this.opts.store.put(row);
    this.notify(row);
    this.transition(row); // failed → added (manual retry)
    void this.drain();
  }

  /** Delete-sheet removal: tombstones the row so a late success can't resurrect. */
  async remove(id: string): Promise<void> {
    const handle = this.scheduled.get(id);
    if (handle !== undefined) {
      this.opts.clock.clearTimeout(handle);
      this.scheduled.delete(id);
    }
    const row = await this.opts.store.get(id);
    if (!row) return;
    row.state = "killed";
    await this.opts.store.put(row);
    this.notify(row);
    this.transition(row); // killed (delete-sheet tombstone)
  }

  /**
   * Cold-start repair (VDC acceptance Bug 1): `process()` persists the
   * `sending` state BEFORE the async upload/commit, and the only
   * demotion back to `added` is the in-memory backoff timer — a tab
   * that dies mid-flight strands its row in `sending` forever, out of
   * drain()'s reach and invisible to retry/delete. Called once at
   * engine mount: demote every persisted `sending` row to `added`.
   * Re-claiming a row whose transaction DID land is a safe no-op (the
   * entry docId IS the clientGuid → the replay early-returns) and the
   * photo upload dedupes on the sha-named path.
   */
  async recoverStale(): Promise<void> {
    for (;;) {
      const row = await this.opts.store.next(["sending"]);
      if (!row) break;
      row.state = "added";
      await this.opts.store.put(row);
      this.notify(row);
      this.transition(row); // sending → added (cold-start repair)
    }
  }

  /**
   * Retention (§4): `sent` rows older than 7 days and every `killed`
   * tombstone are deleted when the store can delete. A deleted row is
   * as safe as a tombstone for a late in-flight success: `process()`
   * treats a missing row like a killed one. Without `delete`, aged
   * `sent` rows are tombstoned as before.
   */
  async pruneSent(): Promise<number> {
    const cutoff = this.opts.clock.now() - SENT_RETENTION_MS;
    const { store } = this.opts;
    if (store.list && store.delete) {
      let removed = 0;
      for (const row of await store.list(["sent", "killed"])) {
        if (row.state === "sent" && (row.sentAt === undefined || row.sentAt > cutoff)) continue;
        if (this.scheduled.has(row.id)) continue;
        await store.delete(row.id);
        removed += 1;
      }
      return removed;
    }
    const doomed: string[] = [];
    for (;;) {
      const row = await this.opts.store.next(["sent"]);
      if (!row || row.sentAt === undefined || row.sentAt > cutoff) break;
      doomed.push(row.id);
      row.state = "killed";
      await this.opts.store.put(row);
      this.transition(row); // sent → killed (retention prune)
    }
    return doomed.length;
  }

  // ── internals ─────────────────────────────────────────────────

  private async process(row: OutboxRecord): Promise<void> {
    const { store, executor, clock } = this.opts;
    row.state = "sending";
    await store.put(row);
    this.notify(row);
    this.transition(row); // added → sending
    try {
      await executor.uploadPhotos(row);
      const result = await executor.commit(row);
      const fresh = await store.get(row.id);
      if (!fresh || fresh.state === "killed") return; // tombstoned mid-flight
      fresh.state = "sent";
      fresh.sentAt = clock.now();
      const taskId = (result as { taskId?: string } | undefined)?.taskId;
      if (taskId) fresh.resultTaskId = taskId;
      await store.put(fresh);
      this.notify(fresh);
      this.transition(fresh); // sending → sent
    } catch (err) {
      const fresh = await store.get(row.id);
      if (!fresh || fresh.state === "killed") return;
      fresh.lastError = describeOutboxError(err);
      if (!this.isOnline()) {
        // Offline: not the row's fault — no attempt counted, back to
        // `added` for the `online` event (the drain loop stops).
        fresh.state = "added";
        await store.put(fresh);
        this.notify(fresh);
        this.transition(fresh); // sending → added (offline)
        return;
      }
      fresh.attempts += 1;
      if (classifyOutboxError(err) === "fatal" || fresh.attempts >= MAX_ATTEMPTS) {
        fresh.state = "failed";
        await store.put(fresh);
        this.notify(fresh);
        this.transition(fresh); // sending → failed (fatal / attempts exhausted)
      } else {
        // Row stays `sending` until the backoff timer re-arms it —
        // flipping it to `added` immediately would make the drain
        // loop spin instead of honoring the schedule. The timer
        // callback demotes it to `added` and kicks the next pass.
        const delay =
          BACKOFF_MS[Math.min(fresh.attempts - 1, BACKOFF_MS.length - 1)] +
          Math.floor(clock.random() * 500);
        await store.put(fresh);
        this.notify(fresh);
        this.scheduled.set(
          fresh.id,
          clock.setTimeout(() => {
            this.scheduled.delete(fresh.id);
            void (async () => {
              const r = await store.get(fresh.id);
              if (r && r.state === "sending") {
                r.state = "added";
                await store.put(r);
                this.transition(r); // sending → added (backoff re-arm)
              }
              await this.drain();
            })();
          }, delay),
        );
      }
    }
  }

  private notify(row: OutboxRecord): void {
    this.opts.onStateChange?.(row);
  }

  /**
   * Fire the transition observer (spec §7 U6) with a minimal
   * `{ uuid, kind, state }` record.
   *
   * Behaviour-preserving: the observer is optional (default
   * undefined → zero cost), it never sees the payload, and a
   * throwing observer is swallowed so it can never break the outbox
   * state machine.
   */
  private transition(row: OutboxRecord): void {
    const observer = this.opts.onTransition;
    if (!observer) return;
    try {
      observer({
        uuid: row.id,
        kind: row.kind,
        state: row.state,
      });
    } catch {
      // An observer must never break the outbox state machine.
    }
  }
}
