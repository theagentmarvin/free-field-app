import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  initTelemetry,
  shouldDropEvent,
  scrubEvent,
  scrubBreadcrumb,
  scrubData,
  createRateLimiter,
  attachSentryBreadcrumbBridge,
  createTelemetry,
  type SentryBreadcrumbSink,
  type TelemetryConfig,
} from "../src/index";
import { resetSentryForTests } from "../src/sentry/index";

// Mock @sentry/browser so these tests are Sentry-free (no live DSN).
const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

vi.mock("@sentry/browser", () => ({
  init: sentryMock.init,
  setTag: sentryMock.setTag,
  addBreadcrumb: sentryMock.addBreadcrumb,
}));

describe("shouldDropEvent (ignore-filter, Sentry-free)", () => {
  it("drops ResizeObserver loop noise", () => {
    expect(
      shouldDropEvent({
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    ).toBe(true);
  });

  it("drops AbortError messages", () => {
    expect(
      shouldDropEvent({ message: "AbortError: The operation was aborted" }),
    ).toBe(true);
  });

  it("drops DOMException code 18 (legacy AbortError)", () => {
    expect(
      shouldDropEvent({
        exception: {
          values: [{ type: "DOMException", code: 18, value: "The operation was aborted." }],
        },
      }),
    ).toBe(true);
  });

  it("drops offline fetch failures (network-class)", () => {
    expect(
      shouldDropEvent(
        { message: "TypeError: Failed to fetch" },
        { online: false },
      ),
    ).toBe(true);
  });

  it("keeps the same fetch failure when online", () => {
    expect(
      shouldDropEvent(
        { message: "TypeError: Failed to fetch" },
        { online: true },
      ),
    ).toBe(false);
  });

  it("always keeps uncaught events (handled === false)", () => {
    expect(
      shouldDropEvent({
        handled: false,
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined (reading 'x')",
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("keeps uncaught events even when the message is noise", () => {
    expect(
      shouldDropEvent({
        handled: false,
        message: "ResizeObserver loop completed with undelivered notifications.",
      }),
    ).toBe(false);
  });

  it("rate-limits chunk-load errors to ~3/min per type", () => {
    const limiter = createRateLimiter(3);
    let t = 0;
    const opts = { rateLimiter: limiter, now: () => t, online: true };
    const evt = { message: "Loading chunk 123 failed" };

    expect(shouldDropEvent(evt, opts)).toBe(false); // 1st → keep
    expect(shouldDropEvent(evt, opts)).toBe(false); // 2nd → keep
    expect(shouldDropEvent(evt, opts)).toBe(false); // 3rd → keep
    expect(shouldDropEvent(evt, opts)).toBe(true); // 4th → drop (over cap)

    // after the window slides open, it is allowed again
    t = 60_001;
    expect(shouldDropEvent(evt, opts)).toBe(false);
  });
});

describe("scrub (PII + >200-char data)", () => {
  it("truncates string values over 200 chars", () => {
    const out = scrubEvent({ extra: { long: "x".repeat(500) } });
    expect((out.extra?.long as string).length).toBe(200);
  });

  it("drops keys matching /email|name|token/i", () => {
    const out = scrubData({
      email: "a@b.com",
      fullName: "Jane Doe",
      api_token: "secret",
      ok: "kept",
    });
    expect(out).toEqual({ ok: "kept" });
  });

  it("scrubs breadcrumb data (PII dropped, long values cut)", () => {
    const crumb = scrubBreadcrumb({
      category: "model",
      message: "load-start",
      data: { email: "a@b.com", note: "x".repeat(300) },
    });
    expect(crumb?.data?.email).toBeUndefined();
    expect((crumb?.data?.note as string).length).toBe(200);
  });

  it("scrubs nested objects recursively", () => {
    const out = scrubData({
      user: { token: "secret", profile: { name: "hidden", blob: "y".repeat(250) } },
    });
    const user = out.user as Record<string, unknown>;
    expect(user.token).toBeUndefined();
    const profile = user.profile as Record<string, unknown>;
    expect(profile.name).toBeUndefined();
    expect((profile.blob as string).length).toBe(200);
  });
});

describe("initTelemetry / initSentry", () => {
  beforeEach(() => {
    resetSentryForTests();
    sentryMock.init.mockClear();
    sentryMock.setTag.mockClear();
    sentryMock.addBreadcrumb.mockClear();
  });

  it("no-ops with a warn when there is no DSN (never imports Sentry)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initTelemetry({});
    expect(sentryMock.init).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no-ops when the DSN is an empty string", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await initTelemetry({ sentry: { dsn: "   ", environment: "production" } });
    expect(sentryMock.init).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("lazy-loads Sentry + inits + sets identity/scope tags when DSN present", async () => {
    await initTelemetry({
      sentry: { dsn: "https://x@y.example/1", environment: "production" },
      identity: { uidHash: "u1", projectHash: "p1" },
    });

    expect(sentryMock.init).toHaveBeenCalledTimes(1);
    const opts = sentryMock.init.mock.calls[0][0] as {
      dsn: string;
      environment: string;
      beforeSend: (event: unknown, hint?: unknown) => unknown;
      beforeBreadcrumb: (b: unknown, hint?: unknown) => unknown;
    };
    expect(opts.dsn).toBe("https://x@y.example/1");
    expect(opts.environment).toBe("production");
    expect(typeof opts.beforeSend).toBe("function");
    expect(typeof opts.beforeBreadcrumb).toBe("function");
    expect(sentryMock.setTag).toHaveBeenCalledWith("user_hash", "u1");
    expect(sentryMock.setTag).toHaveBeenCalledWith("project_hash", "p1");
  });

  it("wires beforeSend to drop noise via the ignore-filter", async () => {
    await initTelemetry({
      sentry: { dsn: "https://x@y.example/1", environment: "production" },
    });
    const opts = sentryMock.init.mock.calls[0][0] as {
      beforeSend: (event: unknown, hint?: unknown) => unknown;
    };
    expect(opts.beforeSend({ message: "ResizeObserver loop completed" }, {})).toBeNull();
  });

  it("is idempotent (repeat call is a no-op)", async () => {
    const cfg: TelemetryConfig = {
      sentry: { dsn: "https://x@y.example/1", environment: "production" },
    };
    await initTelemetry(cfg);
    await initTelemetry(cfg);
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
  });
});

describe("attachSentryBreadcrumbBridge", () => {
  it("mirrors every breadcrumb call into the sink and detaches cleanly", () => {
    type Crumb = { type?: string; category?: string; message?: string; data?: Record<string, unknown> };
    const add = vi.fn<(crumb: Crumb) => void>();
    const sink: SentryBreadcrumbSink = { addBreadcrumb: add };

    const t = createTelemetry();
    const detach = attachSentryBreadcrumbBridge(t, sink);

    t.breadcrumb("model", "load-start", { file: "a.ifc" });
    t.breadcrumb("route", "/projects/42");

    expect(add).toHaveBeenCalledTimes(2);
    const first = add.mock.calls[0][0];
    expect(first.category).toBe("model");
    expect(first.message).toBe("load-start");
    expect(first.data).toEqual({ file: "a.ifc" });

    detach();
    t.breadcrumb("perf", "frame");
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("still records the original breadcrumb even when the sink throws", () => {
    const t = createTelemetry();
    const bad: SentryBreadcrumbSink = {
      addBreadcrumb: () => {
        throw new Error("sink exploded");
      },
    };
    const detach = attachSentryBreadcrumbBridge(t, bad);
    expect(() => t.breadcrumb("model", "load-start", { ok: true })).not.toThrow();
    // original breadcrumb landed in the ring despite the sink failure
    expect(t.getBundle().breadcrumbs).toHaveLength(1);
    detach();
  });
});