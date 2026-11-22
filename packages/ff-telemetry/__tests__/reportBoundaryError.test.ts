import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTelemetry,
  reportBoundaryError,
  resetPersistThrottle,
  setErrorReporter,
  type ErrorReporter,
} from "../src/index";
import { setGlobalTelemetry } from "../src/singleton";

afterEach(() => {
  setErrorReporter(null);
  setGlobalTelemetry(null);
  resetPersistThrottle();
});

describe("reportBoundaryError", () => {
  it("sends module + component stack to the installed reporter", () => {
    const captureException = vi.fn();
    setErrorReporter({ captureException } satisfies ErrorReporter);
    const err = new Error("render blew up");
    reportBoundaryError(err, { module: "Documents", componentStack: "\n    at Viewer\n    at Documents" });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [sent, extra] = captureException.mock.calls[0];
    expect(sent).toBe(err);
    expect(extra).toMatchObject({
      category: "error:react-boundary",
      module: "Documents",
      componentStack: "at Viewer\n    at Documents",
    });
  });

  it("writes a breadcrumb into the registered telemetry ring", () => {
    const telemetry = createTelemetry({} as never);
    setGlobalTelemetry(telemetry);
    reportBoundaryError(new Error("x"), { module: "Tasks" });
    const crumbs = telemetry.getBundle().breadcrumbs as Array<{ category: string; data?: Record<string, unknown> }>;
    const hit = crumbs.find((c) => c.category === "error:react-boundary");
    expect(hit?.data?.module).toBe("Tasks");
  });

  it("is a silent no-op when telemetry and Channel A are off (local-only / opt-out builds)", () => {
    expect(() => reportBoundaryError(new Error("x"), { module: "Models" })).not.toThrow();
  });

  it("never throws even if the reporter does, and truncates long stacks", () => {
    const captureException = vi.fn(() => {
      throw new Error("reporter down");
    });
    setErrorReporter({ captureException });
    expect(() =>
      reportBoundaryError("string error", { module: "M", componentStack: "a".repeat(5000) }),
    ).not.toThrow();
    const extra = (captureException.mock.calls[0] as unknown as [unknown, { componentStack: string }])[1];
    expect(extra.componentStack.length).toBeLessThanOrEqual(2000);
  });
});
