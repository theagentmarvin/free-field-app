// @vitest-environment jsdom
// Wave 64 — ErrorBoundary can portal its fallback into a container
// (the persistent viewer's host node), so the error shows where the
// 3D surface was instead of at the end of the shell.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ErrorBoundary } from "@shell/ErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("boom");
}

afterEach(() => cleanup());

describe("ErrorBoundary fallbackContainer", () => {
  it("renders the fallback inside the given container", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { container } = render(
      <ErrorBoundary label="The 3D viewer" fallbackContainer={host}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(host.querySelector('[data-testid="error-boundary"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="error-boundary"]')).toBeNull();
    host.remove();
    spy.mockRestore();
  });

  it("renders in place without a container", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-testid="error-boundary"]')).not.toBeNull();
    spy.mockRestore();
  });
});
