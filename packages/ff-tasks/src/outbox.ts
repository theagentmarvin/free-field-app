import type { OutboxRecord, OutboxState } from "@ff/types";

import type { TaskActionPayload } from "./action";

/**
 * Offline write queue engine (plan §4). Pure state machine over an
 * injected store + clock so the retry/backoff behaviour is unit-testable
 * without Dexie or timers. The Dexie-backed adapter lives in `local.ts`.
 */

export const BACKOFF_MS: readonly [number, number, number] = [1000, 5000, 20000];
export const MAX_ATTEMPTS = 3;
/** Network-unreachable backoff: first wait and cap (doubles per consecutive failure). */
export const NETWORK_BACKOFF_BASE_MS = 5000;
export const NETWORK_BACKOFF_MAX_MS = 60000;
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
  /**
   * Index-only row count for these states (never hydrates rows). Lets
   * `pickNext` skip the full active-row scan when nothing can block the
   * oldest `added` row. May over-count (rows of other kinds/projects); an
   * over-count only costs the slow path, never correctness.
   */
  count?(states: readonly OutboxState[]): Promise<number>;
}

// ── Cross-tab lock ─────────────────────────────────────────────────

/**
 * Mutual exclusion for the drain and for the cold-start repair. Backed by
 * the Web Locks API so only ONE tab drains a given outbox at a time and a
 * tab never demotes (`recoverStale`) a row another live tab is sending.
 */
export interface OutboxLock {
  /** Run `fn` while holding the lock; waits for the current holder. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

const inProcessTails = new Map<string, Promise<unknown>>();

/**
 * `ff-outbox-<scope>` lock. Uses `navigator.locks` when present (cross-tab);
 * otherwise falls back to an in-process queue per name, which still
 * serialises drain/recover inside this tab but cannot see other tabs
 * (very old browsers; every supported evergreen browser has Web Locks).
 * The lock is released automatically when a tab dies, so a crashed holder
 * never wedges the outbox.
 */
export function createOutboxLock(name: string, locks?: LockManagerLike | null): OutboxLock {
  const mgr: LockManagerLike | null =
    locks !== undefined
      ? locks
      : ((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks ?? null);
  if (mgr && typeof mgr.request === "function") {
    return { run: <T,>(fn: () => Promise<T>) => mgr.request(name, fn) };
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const prev = inProcessTails.get(name) ?? Promise.resolve();
      const result = prev.then(fn, fn);
      inProcessTails.set(
        name,
        result.catch(() => undefined),
      );
      return result;
    },
  };
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
  const rawMsg = (err as { message?: unknown } | null)?.message;
  const message =
    err instanceof Error ? err.message : typeof rawMsg === "string" ? rawMsg : String(err);
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

/**
 * Backend reachability derived from drain outcomes (not navigator.onLine).
 * - `unknown`: no commit has succeeded or hit a network error yet.
 * - `ok`: the last decisive outcome reached the backend (a commit
 *   succeeded, or the server answered with a fatal rejection).
 * - `unreachable`: the last attempt failed with a `network`-class error.
 */
export type OutboxReachabilityState = "ok" | "unreachable" | "unknown";

export interface OutboxReachability {
  state: OutboxReachabilityState;
  /** Epoch ms (injected clock) of the last network-class failure, or null. */
  lastNetworkErrorAt: number | null;
  /** Epoch ms of the last successful commit, or null. */
  lastSuccessAt: number | null;
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
  /**
   * Per-key ordering (default: the payload's `taskId`). Rows sharing a key
   * run strictly in creation order: a row waits while an earlier row of the
   * same key is unsent. Rows with a `null` key are independent. The Phase
   * 1c/1d sync queue keys on the synced doc / blob version id so a version
   * doc never overtakes its blob upload.
   */
  orderKey?: (row: OutboxRecord) => string | null;
  /** Called whenever the reachability snapshot changes (state or timestamps). */
  onReachabilityChange?: (reachability: OutboxReachability) => void;
  /**
   * Cross-tab exclusion (see `createOutboxLock`). When set, the drain loop
   * and `recoverStale` run only while holding it. Omitted = single-writer
   * behaviour as before (unit tests, injected engines).
   */
  lock?: OutboxLock;
}

export class OutboxEngine {
  private opts: OutboxEngineOptions;
  private draining = false;
  private scheduled = new Map<string, unknown>();
  private networkTimer: unknown = undefined;
  private networkStreak = 0;
  private reach: OutboxReachability = { state: "unknown", lastNetworkErrorAt: null, lastSuccessAt: null };
  private reachListeners = new Set<(r: OutboxReachability) => void>();

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
   * Enqueue a ready-built row of any kind (Phase 1c/1d sync kinds use this;
   * `enqueue` stays the task-action path). The row must be in state `added`.
   */
  async enqueueRow(row: OutboxRecord): Promise<OutboxRecord> {
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
      // With a lock, a second tab waits here until the holder's loop ends
      // and then re-lists the queue, so rows enqueued meanwhile are not missed.
      if (this.opts.lock) await this.opts.lock.run(() => this.drainLoop());
      else await this.drainLoop();
    } finally {
      this.draining = false;
    }
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      if (!this.isOnline()) break;
      if (this.networkTimer !== undefined) break; // backing off: backend unreachable
      const row = await this.pickNext();
      if (!row) break;
      await this.process(row);
    }
  }

  /**
   * `online` handler: rows that failed only because the network was
   * down go back to `added` with fresh attempts, then the queue
   * drains. Fatal and other failures stay failed for the user.
   */
  async reviveNetworkFailed(): Promise<number> {
    const { store } = this.opts;
    this.clearNetworkBackoff();
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

  /** Current reachability snapshot (a copy). */
  getReachability(): OutboxReachability {
    return { ...this.reach };
  }

  /** Subscribe to reachability changes; returns an unsubscribe fn. */
  subscribeReachability(listener: (r: OutboxReachability) => void): () => void {
    this.reachListeners.add(listener);
    return () => this.reachListeners.delete(listener);
  }

  /** Cancel any network backoff and drain now (manual "retry" / connectivity hint). */
  async resumeNow(): Promise<void> {
    this.clearNetworkBackoff();
    await this.drain();
  }

  private clearNetworkBackoff(): void {
    if (this.networkTimer !== undefined) {
      this.opts.clock.clearTimeout(this.networkTimer);
      this.networkTimer = undefined;
    }
  }

  private setReach(patch: Partial<OutboxReachability>): void {
    const next = { ...this.reach, ...patch };
    const changed =
      next.state !== this.reach.state ||
      next.lastNetworkErrorAt !== this.reach.lastNetworkErrorAt ||
      next.lastSuccessAt !== this.reach.lastSuccessAt;
    if (!changed) return;
    this.reach = next;
    const snap = { ...next };
    for (const l of [...this.reachListeners]) {
      try { l(snap); } catch { /* listener must not break the engine */ }
    }
    try { this.opts.onReachabilityChange?.(snap); } catch { /* ditto */ }
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
    // Fast path: with no `sending`/`failed` rows nothing can block the
    // oldest `added` row (an earlier unsent row of the same key would itself
    // be the oldest `added`). Avoids hydrating and walking every active row
    // on each loop iteration (O(n) per row, O(n^2) per drain).
    if (store.count && (await store.count(["sending", "failed"])) === 0) {
      return store.next(["added"]);
    }
    const rows = await store.list(ACTIVE_OUTBOX_STATES);
    const blocked = new Set<string>();
    for (const row of rows) {
      const key = this.orderKeyOf(row);
      if (row.state === "added" && (key === null || !blocked.has(key))) return row;
      if (key !== null) blocked.add(key);
    }
    return undefined;
  }

  private orderKeyOf(row: OutboxRecord): string | null {
    if (this.opts.orderKey) return this.opts.orderKey(row);
    const taskId = (row.payload as { taskId?: unknown } | undefined)?.taskId;
    return typeof taskId === "string" ? taskId : null;
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
    this.clearNetworkBackoff();
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
    // Only while holding the outbox lock: a tab that holds it is the sole
    // sender, so every persisted `sending` row is stale. If another live
    // tab is mid-send we wait for it to finish instead of demoting its rows.
    if (this.opts.lock) {
      await this.opts.lock.run(() => this.recoverStaleLocked());
      return;
    }
    await this.recoverStaleLocked();
  }

  private async recoverStaleLocked(): Promise<void> {
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
      this.networkStreak = 0;
      this.setReach({ state: "ok", lastSuccessAt: clock.now() });
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
      const cls = classifyOutboxError(err);
      if (cls === "network") {
        // OS says online but the backend is unreachable (captive portal,
        // LAN without uplink): not the row's fault. No attempt counted,
        // row stays pending (`added`) with lastError, and the whole drain
        // pauses on a capped exponential timer instead of spinning.
        fresh.state = "added";
        await store.put(fresh);
        this.notify(fresh);
        this.transition(fresh); // sending → added (backend unreachable)
        this.networkStreak += 1;
        this.setReach({ state: "unreachable", lastNetworkErrorAt: clock.now() });
        const delay =
          Math.min(NETWORK_BACKOFF_MAX_MS, NETWORK_BACKOFF_BASE_MS * 2 ** (this.networkStreak - 1)) +
          Math.floor(clock.random() * 500);
        this.clearNetworkBackoff();
        this.networkTimer = clock.setTimeout(() => {
          this.networkTimer = undefined;
          void this.drain();
        }, delay);
        return;
      }
      if (cls === "fatal") this.setReach({ state: "ok" }); // the server answered
      fresh.attempts += 1;
      if (cls === "fatal" || fresh.attempts >= MAX_ATTEMPTS) {
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
