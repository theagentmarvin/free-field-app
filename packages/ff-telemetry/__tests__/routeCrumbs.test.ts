// Wave 18 U6 — route breadcrumb source (spec §7 U6 / §6).
//
// The router seam lives in the telemetry package: ONE popstate
// listener + a monkey-patch of history.pushState/replaceState. These
// tests pin the three promises of the unit:
//   1. `route` category crumbs are emitted on navigation;
//   2. the crumb carries the PATHNAME ONLY (no query string, no hash
//      — the spec's PII rule);
//   3. zero cost while telemetry is uninitialized, and the history
//      patch is fully restored on detach.

import { describe, it, expect } from "vitest";

import {
  startRouteCrumbs,
  routePathname,
  ROUTE_BREADCRUMB_CATEGORY,
  type RouteCrumbsTelemetry,
} from "../src/routeCrumbs";

interface Crumb {
  category: string;
  action: string;
  data?: Record<string, unknown>;
}

function fakeTelemetry(): RouteCrumbsTelemetry & { crumbs: Crumb[] } {
  const crumbs: Crumb[] = [];
  return {
    crumbs,
    breadcrumb(category: string, action: string, data?: Record<string, unknown>) {
      crumbs.push({ category, action, data });
    },
  };
}

class FakeHistory {
  pushed: string[] = [];
  replaced: string[] = [];
  location = {
    pathname: "/apps/current",
    href: "http://localhost/apps/current",
  };
  pushState(_data: unknown, _unused: string, url?: string | URL | null): void {
    this.pushed.push(String(url ?? ""));
  }
  replaceState(_data: unknown, _unused: string, url?: string | URL | null): void {
    this.replaced.push(String(url ?? ""));
  }
}

class FakeWindow {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  location = {
    pathname: "/apps/current",
    href: "http://localhost/apps/current",
  };
  history: FakeHistory;
  constructor(history: FakeHistory) {
    this.history = history;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(type, arr.filter((l) => l !== listener));
  }
  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type });
    }
  }
  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

function harness(): { history: FakeHistory; win: FakeWindow; telemetry: ReturnType<typeof fakeTelemetry> } {
  const history = new FakeHistory();
  const win = new FakeWindow(history);
  const telemetry = fakeTelemetry();
  return { history, win, telemetry };
}

describe("startRouteCrumbs (spec §7 U6 — route breadcrumbs)", () => {
  it("emits a `route` crumb on pushState with the pathname only", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    history.pushState({}, "", "/apps/tasks?token=super-secret#frag");

    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0]?.category).toBe(ROUTE_BREADCRUMB_CATEGORY);
    expect(telemetry.crumbs[0]?.category).toBe("route");
    expect(telemetry.crumbs[0]?.action).toBe("/apps/tasks");
    // No query string, no hash, no user data.
    expect(telemetry.crumbs[0]?.action).not.toContain("?");
    expect(telemetry.crumbs[0]?.action).not.toContain("secret");
    expect(telemetry.crumbs[0]?.action).not.toContain("#");
    detach();
  });

  it("emits a `route` crumb on replaceState", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    history.replaceState({}, "", "/apps/settings");

    expect(telemetry.crumbs).toEqual([
      { category: "route", action: "/apps/settings", data: undefined },
    ]);
    detach();
  });

  it("emits a `route` crumb on popstate (back/forward) using the current path", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    win.location.pathname = "/apps/tasks/42";
    win.dispatch("popstate");

    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0]?.category).toBe("route");
    expect(telemetry.crumbs[0]?.action).toBe("/apps/tasks/42");
    detach();
  });

  it("strips the query string of an absolute URL and keeps the pathname", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    history.pushState({}, "", "https://other.host/apps/reports?q=user-text");

    expect(telemetry.crumbs[0]?.action).toBe("/apps/reports");
    expect(telemetry.crumbs[0]?.action).not.toContain("user-text");
    detach();
  });

  it("resolves a relative URL against the current location", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    history.pushState({}, "", "tasks");

    expect(telemetry.crumbs[0]?.action).toBe("/apps/tasks");
    detach();
  });

  it("uses the current path when pushState is called without a URL argument", () => {
    const { history, win, telemetry } = harness();
    const detach = startRouteCrumbs({ telemetry, history, window: win });

    history.pushState({}, "");

    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0]?.action).toBe("/apps/current");
    detach();
  });

  it("is zero-cost when no telemetry source is given (nothing is attached)", () => {
    const { history, win } = harness();
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    const detach = startRouteCrumbs({ history, window: win });

    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
    expect(win.count("popstate")).toBe(0);
    detach();
  });

  it("attaches but stays silent while the lazy telemetry accessor returns null", () => {
    const { history, win } = harness();
    const telemetry = fakeTelemetry();
    let ready = false;
    const detach = startRouteCrumbs({
      getTelemetry: () => (ready ? telemetry : null),
      history,
      window: win,
    });

    expect(win.count("popstate")).toBe(1);
    history.pushState({}, "", "/apps/tasks");
    expect(telemetry.crumbs).toHaveLength(0); // telemetry uninitialized → no-op

    ready = true;
    history.pushState({}, "", "/apps/tasks");
    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0]?.category).toBe("route");
    detach();
  });

  it("restores the original history methods and removes the listener on detach", () => {
    const { history, win, telemetry } = harness();
    const originalPush = history.pushState;
    const originalReplace = history.replaceState;

    const detach = startRouteCrumbs({ telemetry, history, window: win });
    expect(history.pushState).not.toBe(originalPush);
    expect(win.count("popstate")).toBe(1);

    detach();

    expect(history.pushState).toBe(originalPush);
    expect(history.replaceState).toBe(originalReplace);
    expect(win.count("popstate")).toBe(0);

    // No crumb after detach.
    history.pushState({}, "", "/apps/tasks");
    expect(telemetry.crumbs).toHaveLength(0);
  });

  it("is idempotent while active: a second start does not double-patch", () => {
    const { history, win, telemetry } = harness();
    const originalPush = history.pushState;

    const detachA = startRouteCrumbs({ telemetry, history, window: win });
    const patchedPush = history.pushState;
    const detachB = startRouteCrumbs({ telemetry, history, window: win });

    expect(history.pushState).toBe(patchedPush); // not patched twice
    expect(win.count("popstate")).toBe(1); // not a second listener

    history.pushState({}, "", "/apps/tasks");
    expect(telemetry.crumbs).toHaveLength(1); // one crumb, not two

    detachA();
    expect(history.pushState).toBe(patchedPush); // still alive for B
    detachB();
    expect(history.pushState).toBe(originalPush); // fully restored
  });

  it("a throwing telemetry sink never breaks the navigation", () => {
    const { history, win } = harness();
    const detach = startRouteCrumbs({
      telemetry: {
        breadcrumb() {
          throw new Error("sink exploded");
        },
      },
      history,
      window: win,
    });

    expect(() => history.pushState({}, "", "/apps/tasks")).not.toThrow();
    expect(history.pushed).toEqual(["/apps/tasks"]); // the app's call ran
    detach();
  });

  it("works against the real jsdom history and restores it on detach", () => {
    const telemetry = fakeTelemetry();
    const originalPush = window.history.pushState;

    const detach = startRouteCrumbs({ telemetry });
    expect(window.history.pushState).not.toBe(originalPush);

    window.history.pushState({}, "", "/apps/qa-route");
    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0]?.category).toBe("route");
    expect(telemetry.crumbs[0]?.action).toBe("/apps/qa-route");

    detach();
    expect(window.history.pushState).toBe(originalPush);
  });
});

describe("routePathname", () => {
  it("strips query + hash", () => {
    expect(routePathname("/apps/tasks?a=1#b")).toBe("/apps/tasks");
  });

  it("keeps the pathname of an absolute URL", () => {
    expect(routePathname("https://host/apps/x?y=1")).toBe("/apps/x");
  });

  it("resolves against a base when given one", () => {
    expect(routePathname("tasks", "http://localhost/apps/current")).toBe(
      "/apps/tasks",
    );
  });

  it("is empty for null/undefined/empty input", () => {
    expect(routePathname(null)).toBe("");
    expect(routePathname(undefined)).toBe("");
    expect(routePathname("")).toBe("");
  });
});
