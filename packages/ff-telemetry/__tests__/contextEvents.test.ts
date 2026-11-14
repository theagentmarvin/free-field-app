// Wave 18 U3 — context-loss events + escalation.
//
// Sentry-free by construction: the escalation sink is INJECTED, so
// these tests never touch @sentry/browser. The telemetry recorder is
// a fake (jsdom EventTarget fixture for the canvas).

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  attachContextEvents,
  CONTEXT_FLAPPING_REASON,
  CONTEXT_LOSS_ESCALATION_THRESHOLD,
  CONTEXT_LOST_EVENT,
  CONTEXT_RESTORED_ALIAS_EVENT,
  CONTEXT_RESTORED_EVENT,
  type ContextEventTelemetry,
} from "../src/contextEvents";
import { createTelemetry } from "../src/telemetry";
import {
  attachChannelAErrorBridge,
  getErrorReporter,
  installErrorListeners,
  setErrorReporter,
  type ErrorReporter,
} from "../src/errorListeners";
import { setSentryBreadcrumbSink } from "../src/sentry/breadcrumbs";

/** A fake telemetry recorder that mimics the v1 counter semantics:
 *  `noteDeviceLost()` increments, `noteDeviceRestored()` does NOT. */
function fakeTelemetry(): ContextEventTelemetry & {
  crumbs: Array<{ category: string; action: string; data?: Record<string, unknown> }>;
} {
  let lost = 0;
  const crumbs: Array<{
    category: string;
    action: string;
    data?: Record<string, unknown>;
  }> = [];
  return {
    crumbs,
    breadcrumb(category, action, data) {
      crumbs.push({ category, action, data });
    },
    noteDeviceLost() {
      lost += 1;
    },
    noteDeviceRestored() {
      /* v1 semantics: never decrements */
    },
    get deviceLostCount() {
      return lost;
    },
  };
}

/** A jsdom EventTarget standing in for a WebGL canvas. */
function fakeCanvas(): EventTarget {
  return new EventTarget();
}

function lose(canvas: EventTarget): void {
  canvas.dispatchEvent(new Event(CONTEXT_LOST_EVENT));
}

function restore(canvas: EventTarget): void {
  canvas.dispatchEvent(new Event(CONTEXT_RESTORED_EVENT));
}

describe("attachContextEvents — first-class context breadcrumbs", () => {
  let canvas: EventTarget;
  let telemetry: ReturnType<typeof fakeTelemetry>;

  beforeEach(() => {
    canvas = fakeCanvas();
    telemetry = fakeTelemetry();
  });

  it("records a 'context'/'lost' breadcrumb carrying deviceLostCount", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);

    expect(telemetry.crumbs).toHaveLength(1);
    expect(telemetry.crumbs[0].category).toBe("context");
    expect(telemetry.crumbs[0].action).toBe("lost");
    expect(telemetry.crumbs[0].data).toEqual({ deviceLostCount: 1 });

    detach();
  });

  it("records a 'context'/'restored' breadcrumb carrying deviceLostCount", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);
    restore(canvas);

    expect(telemetry.crumbs.map((c) => c.action)).toEqual(["lost", "restored"]);
    expect(telemetry.crumbs[1].category).toBe("context");
    expect(telemetry.crumbs[1].data).toEqual({ deviceLostCount: 1 });

    detach();
  });

  it("increments the loss counter on loss", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);
    expect(telemetry.deviceLostCount).toBe(1);
    lose(canvas);
    expect(telemetry.deviceLostCount).toBe(2);

    detach();
  });

  it("never decrements the counter on restore (v1 semantics preserved)", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);
    lose(canvas);
    expect(telemetry.deviceLostCount).toBe(2);

    restore(canvas);
    restore(canvas);

    // A restore is NOT a loss — the lifetime counter stays put.
    expect(telemetry.deviceLostCount).toBe(2);

    detach();
  });

  it("records a single restore when both restore event names fire", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);
    canvas.dispatchEvent(new Event(CONTEXT_RESTORED_EVENT));
    canvas.dispatchEvent(new Event(CONTEXT_RESTORED_ALIAS_EVENT));

    expect(telemetry.crumbs.map((c) => c.action)).toEqual(["lost", "restored"]);

    detach();
  });

  it("detaches cleanly — no further breadcrumbs after detach", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    lose(canvas);
    expect(telemetry.crumbs).toHaveLength(1);

    detach();
    lose(canvas);
    restore(canvas);

    expect(telemetry.crumbs).toHaveLength(1);
  });

  it("is a no-op (but never throws) when the target is missing", () => {
    expect(() => attachContextEvents(null, { telemetry })).not.toThrow();
    const detach = attachContextEvents(undefined, { telemetry });
    expect(() => detach()).not.toThrow();
  });

  it("never throws into app code when the telemetry recorder blows up", () => {
    const hostile: ContextEventTelemetry = {
      breadcrumb() {
        throw new Error("recorder exploded");
      },
      noteDeviceLost() {
        throw new Error("counter exploded");
      },
      noteDeviceRestored() {
        throw new Error("restore exploded");
      },
      get deviceLostCount(): number {
        throw new Error("read exploded");
      },
    };
    const detach = attachContextEvents(canvas, { telemetry: hostile });

    expect(() => lose(canvas)).not.toThrow();
    expect(() => restore(canvas)).not.toThrow();
    expect(() => detach()).not.toThrow();
  });
});

describe("attachContextEvents — escalation (>2 losses/session)", () => {
  let canvas: EventTarget;
  let telemetry: ReturnType<typeof fakeTelemetry>;
  let onEscalation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    canvas = fakeCanvas();
    telemetry = fakeTelemetry();
    onEscalation = vi.fn();
  });

  it("does NOT escalate at or below the threshold", () => {
    const detach = attachContextEvents(canvas, {
      telemetry,
      onEscalation,
    });

    lose(canvas);
    lose(canvas);

    expect(onEscalation).not.toHaveBeenCalled();

    detach();
  });

  it("escalates exactly once when the loss count exceeds 2", () => {
    const detach = attachContextEvents(canvas, {
      telemetry,
      onEscalation,
    });

    lose(canvas);
    lose(canvas);
    expect(onEscalation).not.toHaveBeenCalled();

    lose(canvas); // 3rd loss → count 3 > 2 → escalate

    expect(onEscalation).toHaveBeenCalledTimes(1);
    const [message, extra] = onEscalation.mock.calls[0] as [
      string,
      { level: string; reason: string; deviceLostCount: number },
    ];
    expect(message).toBe(CONTEXT_FLAPPING_REASON);
    expect(extra.level).toBe("warning");
    expect(extra.reason).toBe(CONTEXT_FLAPPING_REASON);
    expect(extra.deviceLostCount).toBe(3);

    detach();
  });

  it("escalates only once even as further losses arrive", () => {
    const detach = attachContextEvents(canvas, {
      telemetry,
      onEscalation,
    });

    for (let i = 0; i < 6; i += 1) lose(canvas);

    expect(onEscalation).toHaveBeenCalledTimes(1);

    detach();
  });

  it("does not escalate again after a restore (restore ≠ new loss)", () => {
    const detach = attachContextEvents(canvas, {
      telemetry,
      onEscalation,
    });

    lose(canvas);
    lose(canvas);
    lose(canvas);
    expect(onEscalation).toHaveBeenCalledTimes(1);

    restore(canvas);
    lose(canvas); // 4th loss — still one escalation per session
    expect(onEscalation).toHaveBeenCalledTimes(1);

    detach();
  });

  it("keeps working (and escalates) when no escalation callback is injected", () => {
    const detach = attachContextEvents(canvas, { telemetry });

    expect(() => {
      lose(canvas);
      lose(canvas);
      lose(canvas);
    }).not.toThrow();
    expect(telemetry.deviceLostCount).toBe(3);

    detach();
  });

  it("never throws when the escalation callback itself throws", () => {
    const detach = attachContextEvents(canvas, {
      telemetry,
      onEscalation: () => {
        throw new Error("sink exploded");
      },
    });

    expect(() => {
      lose(canvas);
      lose(canvas);
      lose(canvas);
    }).not.toThrow();

    detach();
  });
});

describe("attachContextEvents — integration with the real telemetry instance", () => {
  it("drives the real v1 counters and breadcrumbs", () => {
    const canvas = fakeCanvas();
    const t = createTelemetry();
    const onEscalation = vi.fn();

    const detach = attachContextEvents(canvas, { telemetry: t, onEscalation });

    lose(canvas);
    restore(canvas);
    expect(t.deviceLostCount).toBe(1);

    lose(canvas);
    lose(canvas);
    expect(t.deviceLostCount).toBe(3);
    expect(onEscalation).toHaveBeenCalledTimes(1);

    const crumbs = t.getBundle().breadcrumbs;
    const contextCrumbs = crumbs.filter((c) => c.category === "context");
    expect(contextCrumbs.map((c) => c.action)).toEqual([
      "lost",
      "restored",
      "lost",
      "lost",
    ]);
    expect(contextCrumbs[0].data?.deviceLostCount).toBe(1);
    // A restore never decrements the lifetime counter.
    expect(contextCrumbs[1].data?.deviceLostCount).toBe(1);
    expect(contextCrumbs[3].data?.deviceLostCount).toBe(3);

    detach();
  });
});

describe("attachContextEvents — listener semantics", () => {
  it("observes without preventing the default (the app owns cancel)", () => {
    const canvas = fakeCanvas();
    const telemetry = fakeTelemetry();
    const detach = attachContextEvents(canvas, { telemetry });

    const evt = new Event(CONTEXT_LOST_EVENT, { cancelable: true });
    canvas.dispatchEvent(evt);

    expect(evt.defaultPrevented).toBe(false);
    expect(telemetry.crumbs).toHaveLength(1);

    detach();
  });

  it("uses the documented escalation threshold", () => {
    expect(CONTEXT_LOSS_ESCALATION_THRESHOLD).toBe(2);
  });
});

describe("errorListeners — Channel-A reporter hook", () => {
  beforeEach(() => {
    setErrorReporter(null);
  });

  it("keeps the v1 local path intact when no reporter is installed", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t);

    window.dispatchEvent(new ErrorEvent("error", { message: "boom" }));

    expect(
      t.getBundle().breadcrumbs.some((c) => c.category === "error:Error"),
    ).toBe(true);
    expect(getErrorReporter()).toBeNull();

    stop();
  });

  it("routes uncaught errors to an injected reporter", () => {
    const t = createTelemetry();
    const captureException = vi.fn();
    const reporter: ErrorReporter = { captureException };
    const stop = installErrorListeners(t, { reporter });

    window.dispatchEvent(new ErrorEvent("error", { message: "kaboom" }));

    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, extra] = captureException.mock.calls[0] as [
      Error,
      { category: string; message: string },
    ];
    expect(err).toBeInstanceOf(Error);
    expect(extra.category).toBe("error:Error");
    expect(extra.message).toContain("kaboom");

    stop();
  });

  it("uses the globally installed reporter when none is injected", () => {
    const t = createTelemetry();
    const captureException = vi.fn();
    setErrorReporter({ captureException });
    const stop = installErrorListeners(t);

    window.dispatchEvent(new ErrorEvent("error", { message: "global boom" }));

    expect(captureException).toHaveBeenCalledTimes(1);

    stop();
    setErrorReporter(null);
  });

  it("never lets a throwing reporter break the local path", () => {
    const t = createTelemetry();
    const stop = installErrorListeners(t, {
      reporter: {
        captureException() {
          throw new Error("reporter exploded");
        },
      },
    });

    expect(() =>
      window.dispatchEvent(new ErrorEvent("error", { message: "still fine" })),
    ).not.toThrow();
    expect(
      t.getBundle().breadcrumbs.some((c) => c.category === "error:Error"),
    ).toBe(true);

    stop();
  });

  it("mirrors the uncaught error through the Channel-A bridge", () => {
    const t = createTelemetry();
    const addBreadcrumb = vi.fn();
    // Install a fake Channel-A sink, then let the error listeners
    // install the bridge — the error crumb must reach the sink.
    setSentryBreadcrumbSink({ addBreadcrumb });

    const stop = installErrorListeners(t);
    window.dispatchEvent(new ErrorEvent("error", { message: "bridged" }));

    expect(addBreadcrumb).toHaveBeenCalled();
    const crumb = addBreadcrumb.mock.calls.find(
      (c) => (c[0] as { category?: string }).category === "error:Error",
    );
    expect(crumb).toBeTruthy();

    stop();
    setSentryBreadcrumbSink(null);
  });

  it("attaches the Channel-A bridge idempotently per telemetry instance", () => {
    const t = createTelemetry();
    expect(attachChannelAErrorBridge(t)).toBe(true);
    expect(attachChannelAErrorBridge(t)).toBe(false);
  });

  it("exposes the bridge attach helper as a no-throw operation", () => {
    expect(() =>
      attachChannelAErrorBridge(null as unknown as ReturnType<typeof createTelemetry>),
    ).not.toThrow();
  });
});
