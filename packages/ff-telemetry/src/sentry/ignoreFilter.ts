// ignoreFilter.ts — Channel A noise filter + PII scrub (§5.1 / §5.6).
//
// `ShouldIgnoreException` analogue, ported to web idioms. This
// module is **pure and dependency-free**: the exported functions are
// testable with plain fixture objects, no Sentry module needed. The
// real Sentry hooks (`beforeSend` / `beforeBreadcrumb`) wrap these in
// `src/sentry/index.ts`.
//
// Survivability law: everything here is a pure function — it never
// throws into the app; callers wrap it in `safe()` as a belt-ander.

/** A minimally-shaped exception value (compatible with Sentry's). */
export interface IgnorableEventValue {
  type?: string;
  value?: string;
  mechanism?: { handled?: boolean };
  /** Legacy DOMException numeric code (18 === ABORT_ERR in old specs). */
  code?: number;
}

/** A minimally-shaped breadcrumb (compatible with Sentry's). */
export interface IgnorableBreadcrumb {
  type?: string;
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A minimally-shaped error event (compatible with Sentry's ErrorEvent). */
export interface IgnorableEvent {
  /** Explicit "uncaught" contract: `handled === false` always passes. */
  handled?: boolean;
  message?: string;
  level?: string;
  exception?: { values?: IgnorableEventValue[] };
  breadcrumbs?: IgnorableBreadcrumb[];
  extra?: Record<string, unknown>;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Injected deps for `shouldDropEvent` (all optional for purity). */
export interface IgnoreFilterOptions {
  /** `navigator.onLine`. Default true (no offline network-class drop). */
  online?: boolean;
  /** Clock source (injectable for deterministic rate-limit tests). */
  now?: () => number;
  /** Per-exception-type rate limiter (injectable). */
  rateLimiter?: RateLimiter;
}

/** Per-key sliding-window rate limiter for event storms (§9.4). */
export interface RateLimiter {
  /** Returns true when `key` is still under its per-minute allowance. */
  allow(key: string, now: number): boolean;
}

const RESIZE_OBSERVER_RE = /resizeobserver loop/i;
const ABORT_RE = /abort/i;
const NETWORK_FAILURE_RE =
  /failed to fetch|fetch failed|networkerror|network request failed|network error|err_internet|net::err|failed to load resource/i;
const CHUNK_LOAD_RE =
  /chunkloaderror|loading chunk|imported module|dynamically imported module|failed to fetch dynamically/i;
const PII_KEY_RE = /email|name|token/i;
const MAX_VALUE_CHARS = 200;
const DEFAULT_MAX_PER_MINUTE = 3;
const RATE_WINDOW_MS = 60_000;

/** True when the event is uncaught — these ALWAYS pass (never dropped). */
function isUncaught(event: IgnorableEvent): boolean {
  if (event.handled === false) return true;
  const mechanismHandled = event.exception?.values?.[0]?.mechanism?.handled;
  if (mechanismHandled === false) return true;
  return false;
}

/** Concatenate every message-ish string on the event for matching. */
function eventText(event: IgnorableEvent): string {
  const parts: string[] = [];
  if (typeof event.message === "string") parts.push(event.message);
  for (const v of event.exception?.values ?? []) {
    if (typeof v.type === "string") parts.push(v.type);
    if (typeof v.value === "string") parts.push(v.value);
  }
  return parts.join(" ");
}

function firstExceptionType(event: IgnorableEvent): string | undefined {
  return event.exception?.values?.[0]?.type;
}

function isAbort(event: IgnorableEvent, text: string): boolean {
  if (ABORT_RE.test(text)) return true;
  for (const v of event.exception?.values ?? []) {
    if (v.type === "DOMException" || v.type === "AbortError") {
      if (v.code === 18) return true;
      if (/abort/i.test(v.value ?? "")) return true;
    }
  }
  return false;
}

/** Default shared rate limiter (module-level; ~3/min per type). */
let sharedRateLimiter: RateLimiter | null = null;

function defaultRateLimiter(): RateLimiter {
  if (sharedRateLimiter === null) sharedRateLimiter = createRateLimiter();
  return sharedRateLimiter;
}

/**
 * Pure noise filter — returns `true` when the event should be dropped.
 *
 * Drop rules (§5.1):
 *  - `ResizeObserver loop *`
 *  - `AbortError` / `DOMException` code 18
 *  - offline (`online === false`) network-class fetch failures
 *  - chunk-load errors beyond ~3/min per exception type (§9.4)
 *
 * `event.handled === false` (uncaught) always passes.
 */
export function shouldDropEvent(
  event: IgnorableEvent,
  options: IgnoreFilterOptions = {},
): boolean {
  const {
    online = true,
    now = () => Date.now(),
    rateLimiter = defaultRateLimiter(),
  } = options;

  if (isUncaught(event)) return false;

  const text = eventText(event);

  if (RESIZE_OBSERVER_RE.test(text)) return true;
  if (isAbort(event, text)) return true;
  if (online === false && NETWORK_FAILURE_RE.test(text)) return true;

  if (CHUNK_LOAD_RE.test(text)) {
    const key = `chunk:${firstExceptionType(event) ?? "unknown"}`;
    if (!rateLimiter.allow(key, now())) return true;
  }

  return false;
}

/** A fresh sliding-window rate limiter (max `maxPerMinute`/key/min). */
export function createRateLimiter(maxPerMinute: number = DEFAULT_MAX_PER_MINUTE): RateLimiter {
  const cap = Number.isFinite(maxPerMinute) && maxPerMinute > 0 ? maxPerMinute : DEFAULT_MAX_PER_MINUTE;
  const buckets = new Map<string, number[]>();

  return {
    allow(key, now) {
      const cut = now - RATE_WINDOW_MS;
      const recent = (buckets.get(key) ?? []).filter((t) => t > cut);
      if (recent.length < cap) {
        recent.push(now);
        buckets.set(key, recent);
        return true;
      }
      buckets.set(key, recent); // keep pruned window
      return false;
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string): string {
  if (value.length <= MAX_VALUE_CHARS) return value;
  return `${value.slice(0, MAX_VALUE_CHARS - 1)}\u2026`;
}

function scrubValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(scrubValue);
  if (isPlainObject(value)) return scrubData(value);
  // functions / symbols / bigint / dates → drop, never leak them.
  return undefined;
}

/**
 * Recursively scrub an arbitrary `data` map (§5.6): drop any key
 * matching /email|name|token/i and truncate string values over 200
 * chars. Returns a NEW object; the input is never mutated.
 */
export function scrubData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (PII_KEY_RE.test(key)) continue;
    out[key] = scrubValue(value);
  }
  return out;
}

/** Scrub a breadcrumb's `data` (PII keys dropped, long values cut). */
export function scrubBreadcrumb(
  breadcrumb: IgnorableBreadcrumb | null | undefined,
): IgnorableBreadcrumb | null {
  if (!breadcrumb) return null;
  const out: IgnorableBreadcrumb = { ...breadcrumb };
  if (out.data !== undefined) {
    const scrubbed = scrubData(out.data);
    out.data = Object.keys(scrubbed).length > 0 ? scrubbed : undefined;
  }
  return out;
}

/** Scrub an error event's free-form `data`/`extra` and its breadcrumbs. */
export function scrubEvent(event: IgnorableEvent): IgnorableEvent {
  const out: IgnorableEvent = { ...event };
  if (isPlainObject(out.extra)) out.extra = scrubData(out.extra);
  if (isPlainObject(out.data)) out.data = scrubData(out.data);
  if (Array.isArray(out.breadcrumbs)) {
    out.breadcrumbs = out.breadcrumbs
      .map((b) => scrubBreadcrumb(b))
      .filter((b): b is IgnorableBreadcrumb => b !== null);
  }
  return out;
}