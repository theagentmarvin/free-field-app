// @vitest-environment jsdom
// apps/settings — wave 52/56 viewer keep-alive tests.
//
// The shared 3D surface must survive module switches between Models,
// Linkview and Documents: lazy-mounted on the first /models, /linkview
// OR /documents visit, then kept alive — so the heavy load +
// tessellation happens exactly once and the WebGL canvas is never
// recreated (one IfcViewer instance, never two).
//
// Wave 56 — /documents now hosts the surface too (the mapping view):
// it mounts the surface but suppresses the Models-only internal
// toolbar (the Documents route renders its own merged toolbar).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, type ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

// Mount counter — the whole point is that the surface kernel mounts ONCE.
const h = vi.hoisted(() => ({ mounts: 0, crash: false }));

vi.mock("@free-field/models", async () => {
  const React = await import("react");
  const HostContext = React.createContext<unknown>(null);
  return {
    PersistentViewerSurface: ({
      showViewerToolbar,
      hostNode,
      renderPaused,
    }: {
      showViewerToolbar: boolean;
      hostNode: HTMLElement | null;
      renderPaused?: boolean;
    }) => {
      useEffect(() => {
        h.mounts += 1;
      }, []);
      if (h.crash) throw new Error("WebGL context lost");
      return (
        <div
          data-testid="persistent-surface"
          data-toolbar={String(showViewerToolbar)}
          data-host={hostNode ? "set" : "null"}
          data-render-paused={String(renderPaused ?? false)}
        />
      );
    },
    ViewerSurfaceHostContext: HostContext,
  };
});

// The guard is auth plumbing, not what's under test — pass through.
vi.mock("@ff/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ff/auth")>();
  return {
    ...actual,
    RequireProjectMember: ({ children }: { children: ReactNode }) => (
      <>{children}</>
    ),
  };
});

import { ViewerKeepAlive } from "@shell/ViewerKeepAlive";
import { act } from "@testing-library/react";
import { useDocumentsViewState } from "../../../documents/src/documentsViewState";

/** NavTo re-navigates the surrounding MemoryRouter on prop change. */
function NavTo({ to }: { to: string }): null {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to);
  }, [to, navigate]);
  return null;
}

/** Start on the non-viewer settings route, then navigate to `at`. */
function tree(at: string) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <ViewerKeepAlive>
        <NavTo to={at} />
      </ViewerKeepAlive>
    </MemoryRouter>
  );
}

describe("ViewerKeepAlive (wave 52/56)", () => {
  beforeEach(() => {
    h.mounts = 0;
  });
  afterEach(() => cleanup());

  it("does not mount the surface until a viewer route is first visited", () => {
    render(tree("/"));

    expect(screen.queryByTestId("persistent-surface")).toBeNull();
    expect(screen.getByTestId("viewer-keepalive")).toHaveAttribute(
      "data-visible",
      "false",
    );
    expect(h.mounts).toBe(0);
  });

  it("mounts once on first /documents visit and survives route switches", () => {
    const utils = render(tree("/"));
    expect(screen.queryByTestId("persistent-surface")).toBeNull();

    // First viewer visit (Documents) → mounts exactly once.
    utils.rerender(tree("/documents"));
    expect(screen.getByTestId("persistent-surface")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-keepalive")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(h.mounts).toBe(1);
    // The Documents route suppresses the surface's internal toolbar.
    expect(screen.getByTestId("persistent-surface")).toHaveAttribute(
      "data-toolbar",
      "false",
    );

    // Switch to Models → SAME instance, internal toolbar re-enabled.
    utils.rerender(tree("/models"));
    expect(screen.getByTestId("persistent-surface")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-keepalive")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId("persistent-surface")).toHaveAttribute(
      "data-toolbar",
      "true",
    );

    // Switch to Linkview → same instance, toolbar suppressed again.
    utils.rerender(tree("/linkview"));
    expect(screen.getByTestId("persistent-surface")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-keepalive")).toHaveAttribute(
      "data-visible",
      "true",
    );
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId("persistent-surface")).toHaveAttribute(
      "data-toolbar",
      "false",
    );

    // Switch to a non-viewer route → kept alive, NOT unmounted, hidden.
    utils.rerender(tree("/"));
    expect(screen.getByTestId("persistent-surface")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-keepalive")).toHaveAttribute(
      "data-visible",
      "false",
    );
    expect(h.mounts).toBe(1);

    // And back to Models → same instance (no reload, no re-tessellation).
    utils.rerender(tree("/models"));
    expect(h.mounts).toBe(1);
  });

  it("mounts once when Linkview is the first visited viewer route", () => {
    const utils = render(tree("/"));
    expect(screen.queryByTestId("persistent-surface")).toBeNull();

    utils.rerender(tree("/linkview"));
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId("persistent-surface")).toHaveAttribute(
      "data-toolbar",
      "false",
    );

    utils.rerender(tree("/models"));
    expect(h.mounts).toBe(1);
    expect(screen.getByTestId("persistent-surface")).toHaveAttribute(
      "data-toolbar",
      "true",
    );
  });

  it("wave 63: pauses surface rendering while a Documents PDF covers it", () => {
    useDocumentsViewState.setState({ pdfOpen: false });
    const { rerender } = render(tree("/documents"));
    const surface = () => screen.getByTestId("persistent-surface");
    expect(surface().getAttribute("data-render-paused")).toBe("false");
    act(() => useDocumentsViewState.setState({ pdfOpen: true }));
    expect(surface().getAttribute("data-render-paused")).toBe("true");
    // Another route never pauses, even with the flag still set.
    rerender(tree("/models"));
    expect(surface().getAttribute("data-render-paused")).toBe("false");
    useDocumentsViewState.setState({ pdfOpen: false });
  });

  it("wave 64: a crashing 3D surface is caught by its own boundary; the route still renders", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.crash = true;
    try {
      render(
        <MemoryRouter initialEntries={["/models"]}>
          <ViewerKeepAlive>
            <div data-testid="route-chrome">chrome</div>
          </ViewerKeepAlive>
        </MemoryRouter>,
      );
      expect(screen.getByTestId("route-chrome")).toBeInTheDocument();
      expect(screen.getByTestId("error-boundary")).toHaveTextContent(
        "The 3D viewer ran into a problem",
      );
      expect(screen.getByTestId("error-boundary")).toHaveTextContent(
        "WebGL context lost",
      );
      // Retry re-mounts the surface once the fault is gone.
      h.crash = false;
      act(() => screen.getByTestId("error-boundary-retry").click());
      expect(screen.getByTestId("persistent-surface")).toBeInTheDocument();
    } finally {
      h.crash = false;
      spy.mockRestore();
    }
  });
});
