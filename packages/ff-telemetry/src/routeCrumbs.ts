// routeCrumbs.ts — router navigation breadcrumbs (spec §7 U6 / §6).
//
// Spec §6, integration-hook table:
//
//   | Router navigation (apps/*) | `breadcrumb("route", path)` via
//   history-listener in bridge, NEVER per-route edits |
//
// So the seam lives HERE, in the telemetry package: ONE `popstate`
// listener plus a monkey-patch of `history.pushState` /
// `history.replaceState`. No route module in `apps/*` is touched and
// no per-route edit is ever needed — the router seam is a single
// attach/detach call (U7 wires it into the app shell).
//
// Privacy (spec §4.2 / §9.5): only the PATHNAME is emitted. Query
// strings and hashes are stripped — that is where project ids, task
// ids, search terms and tokens live, and breadcrumbs must never carry
// user text. `?token=…` can not reach the breadcrumb ring.
//
// Cost (spec §7 U6 "zero cost when telemetry uninitialized"):
//   - No telemetry source at all (neither an instance nor a lazy
//     accessor) → NOTHING is attached: no listener, no history patch.
//     The call is a pure no-op and returns a no-op detach.
//   - A lazy `getTelemetry()` accessor → the listeners are attached
//     (so a telemetry instance created LATER is picked up without
//     re-attaching) but every emission is guarded by a null-check:
//     an uninitialized telemetry means no breadcrumb work at all.
//
// Survivability law: every body is `safe()`-wrapped; the history
// monkey-patch restores the ORIGINAL methods on detach; a throwing
// telemetry sink can never break a navigation.
//
// Zero DOM at module load: nothing here touches `window`/`history`
// until `startRouteCrumbs()` is called.

import { safe } from "./safe";

/** Breadcrumb category for route changes (spec §4.2 closed list). */
export const ROUTE_BREADCRUMB_CATEGORY = "route";

/**
 * The telemetry surface this module needs. Structural on purpose: the
 * v1 `Telemetry` instance satisfies it and tests can inject a tiny
 * fake recorder.
 */
export interface RouteCrumbsTelemetry {
  breadcrumb(
    category: string,
    action: string,
    data?: Record<string, unknown>,
  ): void;
}

/** Minimal `location` shape (pathname + href only). */
export interface RouteCrumbsLocation {
  pathname?: string;
  href?: string;
}

/** Minimal `history` shape — the two methods we monkey-patch. */
export interface RouteCrumbsHistory {
  pushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void;
  replaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void;
  readonly location?: RouteCrumbsLocation | null;
}

/** Minimal `window` shape — the popstate listener host. */
export interface RouteCrumbsWindow {
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
  readonly location?: RouteCrumbsLocation | null;
  readonly history?: RouteCrumbsHistory;
}

/**
 * Where the crumbs go. Either a live instance or a lazy accessor
 * (resolved at navigation time so a late-created instance is picked
 * up without re-attaching).
 */
export interface RouteCrumbsSource {
  /** Live telemetry instance. */
  telemetry?: RouteCrumbsTelemetry | null;
  /** Lazy accessor — may return null while telemetry is uninitialized. */
  getTelemetry?: () => RouteCrumbsTelemetry | null | undefined;
}

/** Injected dependencies for {@link startRouteCrumbs}. */
export interface RouteCrumbsDeps extends RouteCrumbsSource {
  /** History to patch. Defaults to the global `window.history`. */
  history?: RouteCrumbsHistory;
  /** Window hosting the popstate listener. Defaults to the global. */
  window?: RouteCrumbsWindow;
}

/* ── internals ────────────────────────────────────────────────── */

/** Mutable view of the history object (we assign the wrappers on it). */
type MutableHistory = {
  pushState?: RouteCrumbsHistory["pushState"];
  replaceState?: RouteCrumbsHistory["replaceState"];
};

/**
 * One live installation per history object. The WeakMap keeps the
 * "idempotent while active" promise: a second `startRouteCrumbs()`
 * for the same history does NOT patch `pushState` twice and does NOT
 * attach a second popstate listener — it only registers another
 * source.
 */
interface RouteInstallation {
  history: RouteCrumbsHistory;
  sources: Set<RouteCrumbsSource>;
  popListeners: Array<{
    win: RouteCrumbsWindow;
    listener: (event: unknown) => void;
  }>;
  originalPush: RouteCrumbsHistory["pushState"];
  originalReplace: RouteCrumbsHistory["replaceState"];
  hadOwnPush: boolean;
  hadOwnReplace: boolean;
}

const installations = new WeakMap<object, RouteInstallation>();

/** Resolve the telemetry instance a source points at (null = not ready). */
function resolveTelemetry(source: RouteCrumbsSource): RouteCrumbsTelemetry | null {
  if (source.telemetry) return source.telemetry;
  if (typeof source.getTelemetry === "function") {
    const resolved = safe(
      () => source.getTelemetry?.(),
      "getTelemetry failed",
    );
    return resolved ?? null;
  }
  return null;
}

/**
 * Strip a URL down to its pathname. Query string AND hash are
 * dropped — the crumb must never carry user data (spec §9.5).
 */
export function routePathname(
  raw: string | URL | null | undefined,
  base?: string,
): string {
  if (raw === null || raw === undefined) return "";
  const text = typeof raw === "string" ? raw : raw.href ?? String(raw);
  if (text === "") return "";
  try {
    const url = base ? new URL(text, base) : new URL(text);
    return url.pathname || "/";
  } catch {
    // Relative URL without a usable base — strip by hand.
    const withoutHash = text.split("#")[0] ?? "";
    const withoutQuery = withoutHash.split("?")[0] ?? "";
    if (withoutQuery === "") return "";
    if (withoutQuery.startsWith("/")) return withoutQuery;
    const slash = withoutQuery.lastIndexOf("/");
    return slash === -1 ? `/${withoutQuery}` : withoutQuery.slice(slash);
  }
}

/** Current location href (used as the base for relative URLs). */
function baseHref(installation: RouteInstallation): string | undefined {
  // The WINDOW location wins: in a browser `history.location` and
  // `window.location` are the same Location object, and the window
  // is the authoritative "where am I now" after a navigation.
  for (const entry of installation.popListeners) {
    const href = entry.win.location?.href;
    if (typeof href === "string" && href !== "") return href;
  }
  const fromHistory = installation.history.location?.href;
  if (typeof fromHistory === "string" && fromHistory !== "") return fromHistory;
  return undefined;
}

/** Current location pathname (used for popstate crumbs). */
function currentPathname(installation: RouteInstallation): string {
  for (const entry of installation.popListeners) {
    const pathname = entry.win.location?.pathname;
    if (typeof pathname === "string" && pathname !== "") return pathname;
  }
  const fromHistory = installation.history.location?.pathname;
  if (typeof fromHistory === "string" && fromHistory !== "") return fromHistory;
  return "";
}

/**
 * The pathname a navigation lands on. `pushState`/`replaceState`
 * without a URL argument do not change the route — the current
 * location is the honest answer (and never an empty crumb).
 */
function pathFor(
  installation: RouteInstallation,
  url: string | URL | null | undefined,
): string {
  if (url === null || url === undefined || url === "") {
    return currentPathname(installation);
  }
  return routePathname(url, baseHref(installation));
}

/**
 * Emit ONE `route` crumb per distinct telemetry instance. Sources
 * resolving to the same instance (double start, or an instance plus
 * an accessor pointing at it) collapse into a single crumb.
 */
function emit(installation: RouteInstallation, pathname: string): void {
  const seen = new Set<unknown>();
  for (const source of installation.sources) {
    const telemetry = resolveTelemetry(source);
    if (!telemetry) continue; // telemetry uninitialized → no-op guard
    if (seen.has(telemetry)) continue;
    seen.add(telemetry);
    safe(
      () => telemetry.breadcrumb(ROUTE_BREADCRUMB_CATEGORY, pathname),
      "route breadcrumb failed",
    );
  }
}

/** Restore a monkey-patched history method. */
function restoreMethod(
  target: MutableHistory,
  key: "pushState" | "replaceState",
  original: unknown,
  hadOwn: boolean,
): void {
  try {
    if (!hadOwn) {
      delete target[key];
      if (!Object.prototype.hasOwnProperty.call(target, key)) return;
    }
  } catch {
    /* fall through to the assignment below */
  }
  try {
    (target as Record<string, unknown>)[key] = original;
  } catch {
    /* give up silently — the patch is best-effort by design */
  }
}

/** Remove every listener and restore the original history methods. */
function teardown(installation: RouteInstallation): void {
  const target = installation.history as unknown as MutableHistory;
  restoreMethod(target, "pushState", installation.originalPush, installation.hadOwnPush);
  restoreMethod(
    target,
    "replaceState",
    installation.originalReplace,
    installation.hadOwnReplace,
  );
  for (const entry of installation.popListeners) {
    safe(
      () => entry.win.removeEventListener("popstate", entry.listener),
      "remove popstate listener failed",
    );
  }
  installation.popListeners = [];
  installation.sources.clear();
  installations.delete(installation.history as unknown as object);
}

/** Get (or create) the installation for a history object. */
function ensureInstallation(
  history: RouteCrumbsHistory,
  win: RouteCrumbsWindow | null,
): RouteInstallation {
  const existing = installations.get(history as unknown as object);
  if (existing) {
    // Idempotent while active: reuse the patch, but make sure this
    // window has the ONE popstate listener.
    if (win && !existing.popListeners.some((entry) => entry.win === win)) {
      const listener = (): void => {
        safe(
          () => emit(existing, currentPathname(existing)),
          "popstate route crumb failed",
        );
      };
      win.addEventListener("popstate", listener);
      existing.popListeners.push({ win, listener });
    }
    return existing;
  }

  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  const hadOwnPush = Object.prototype.hasOwnProperty.call(history, "pushState");
  const hadOwnReplace = Object.prototype.hasOwnProperty.call(
    history,
    "replaceState",
  );

  const installation: RouteInstallation = {
    history,
    sources: new Set<RouteCrumbsSource>(),
    popListeners: [],
    originalPush,
    originalReplace,
    hadOwnPush,
    hadOwnReplace,
  };

  const wrappedPush = function (
    this: unknown,
    data: unknown,
    _unused: string,
    url?: string | URL | null,
  ): void {
    // The APP's call semantics are preserved: an error thrown by the
    // original method propagates untouched, and no crumb is emitted
    // for a navigation that did not happen.
    originalPush.call(this, data, _unused, url);
    safe(
      () => emit(installation, pathFor(installation, url)),
      "pushState route crumb failed",
    );
  };

  const wrappedReplace = function (
    this: unknown,
    data: unknown,
    _unused: string,
    url?: string | URL | null,
  ): void {
    originalReplace.call(this, data, _unused, url);
    safe(
      () => emit(installation, pathFor(installation, url)),
      "replaceState route crumb failed",
    );
  };

  safe(() => {
    (history as unknown as MutableHistory).pushState = wrappedPush;
    (history as unknown as MutableHistory).replaceState = wrappedReplace;
  }, "history patch failed");

  installations.set(history as unknown as object, installation);

  if (win) {
    const listener = (): void => {
      safe(
        () => emit(installation, currentPathname(installation)),
        "popstate route crumb failed",
      );
    };
    win.addEventListener("popstate", listener);
    installation.popListeners.push({ win, listener });
  }

  return installation;
}

/** The global window (null outside a browser/jsdom). */
function defaultWindow(): RouteCrumbsWindow | null {
  const g = globalThis as unknown as { window?: RouteCrumbsWindow };
  return g.window ?? null;
}

/** The global history (null outside a browser/jsdom). */
function defaultHistory(): RouteCrumbsHistory | null {
  const win = defaultWindow();
  return win?.history ?? null;
}

/**
 * Start emitting `route` breadcrumbs for router navigation.
 *
 * Behaviour:
 *   - `history.pushState` / `history.replaceState` are wrapped once
 *     (the ORIGINAL methods are restored on detach);
 *   - ONE `popstate` listener is attached per window;
 *   - every emission is `breadcrumb("route", pathname)` — pathname
 *     only, query string and hash stripped;
 *   - with no telemetry source nothing is attached at all (zero cost
 *     while telemetry is uninitialized); with a lazy `getTelemetry()`
 *     accessor the listeners exist but stay silent until an instance
 *     is available.
 *
 * Returns a detach function. Safe(): never throws into app code.
 */
export function startRouteCrumbs(deps: RouteCrumbsDeps = {}): () => void {
  return (
    safe(() => {
      const telemetry = deps.telemetry ?? null;
      const accessor =
        typeof deps.getTelemetry === "function" ? deps.getTelemetry : undefined;

      // Zero cost when telemetry is not wired: nothing is attached.
      if (!telemetry && !accessor) {
        return () => {
          /* nothing attached */
        };
      }

      const history = deps.history ?? defaultHistory();
      if (
        !history ||
        typeof history.pushState !== "function" ||
        typeof history.replaceState !== "function"
      ) {
        return () => {
          /* no history to patch */
        };
      }

      const win = deps.window ?? defaultWindow();
      const installation = ensureInstallation(history, win);
      const source: RouteCrumbsSource = { telemetry, getTelemetry: accessor };
      installation.sources.add(source);

      let detached = false;
      return () => {
        if (detached) return;
        detached = true;
        safe(() => {
          installation.sources.delete(source);
          // Other consumers may still be attached — keep the patch.
          if (installation.sources.size > 0) return;
          teardown(installation);
        }, "route crumbs detach failed");
      };
    }, "startRouteCrumbs failed") ??
    (() => {
      /* no-op detach */
    })
  );
}
