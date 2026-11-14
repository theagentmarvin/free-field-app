// apps/settings — demo-mode shell tests (plan v4 amendment v4.1).
//
// Covers the three demo-aware pieces of the shell:
//   - <RequireAdmin>        → demo viewer is bounced to /documents,
//                             demo admin passes.
//   - <RequireProjectMember>→ demo viewer is a valid member (always passes).
//   - <LeftRail>            → viewer sees only the consumption entries;
//                             the mocked sign-in toggle swaps in the
//                             admin-only entries.
//
// These use the REAL @ff/auth sources (the workspace alias points at
// packages/ff-auth/src), so no @ff/auth shim is needed — the demo branch
// of <AuthProvider> skips Firebase entirely, which is exactly what makes
// the demo testable without any backend.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AuthProvider, RequireAdmin, RequireProjectMember, setDemoRole } from "@ff/auth";

import LeftRail from "@shell/LeftRail";

function renderWithShell(ui: React.ReactNode, initialPath = "/") {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>{ui}</MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  // Demo mode on: no Firebase, no sign-in.
  vi.stubEnv("VITE_FF_DEMO_AUTH", "true");
  localStorage.clear();
  setDemoRole("viewer");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("demo guards", () => {
  it("blocks a demo viewer from the admin route and redirects to /models", () => {
    renderWithShell(
      <Routes>
        <Route
          path="/"
          element={
            <RequireAdmin>
              <div data-testid="admin-only">settings</div>
            </RequireAdmin>
          }
        />
        <Route path="/models" element={<div data-testid="models">models</div>} />
      </Routes>,
    );

    expect(screen.queryByTestId("admin-only")).toBeNull();
    expect(screen.getByTestId("models")).toBeInTheDocument();
  });

  it("lets a demo admin through to the admin route", () => {
    setDemoRole("admin");

    renderWithShell(
      <Routes>
        <Route
          path="/"
          element={
            <RequireAdmin>
              <div data-testid="admin-only">settings</div>
            </RequireAdmin>
          }
        />
        <Route path="/documents" element={<div data-testid="documents">documents</div>} />
      </Routes>,
    );

    expect(screen.getByTestId("admin-only")).toBeInTheDocument();
    expect(screen.queryByTestId("documents")).toBeNull();
  });

  it("lets a demo viewer into the project-member routes", () => {
    renderWithShell(
      <Routes>
        <Route
          path="/documents"
          element={
            <RequireProjectMember>
              <div data-testid="member-content">documents</div>
            </RequireProjectMember>
          }
        />
        <Route path="/sign-in" element={<div data-testid="sign-in">sign in</div>} />
      </Routes>,
      "/documents",
    );

    expect(screen.getByTestId("member-content")).toBeInTheDocument();
    expect(screen.queryByTestId("sign-in")).toBeNull();
  });
});

describe("demo left rail", () => {
  it("shows only the consumption entries to a viewer", () => {
    renderWithShell(<LeftRail />);

    expect(screen.getByTestId("left-rail-icon-documents")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-icon-models")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-icon-linkview")).toBeInTheDocument();
    expect(screen.queryByTestId("left-rail-icon-settings")).toBeNull();
    expect(screen.queryByTestId("left-rail-icon-users")).toBeNull();
  });

  it("renders the mocked sign-in switch in demo mode", () => {
    renderWithShell(<LeftRail />);

    expect(screen.getByTestId("left-rail-demo-switch")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-demo-role-viewer")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("left-rail-demo-role-admin")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("swaps the admin entries in when the toggle is flipped to admin", () => {
    renderWithShell(<LeftRail />);

    expect(screen.queryByTestId("left-rail-icon-settings")).toBeNull();

    fireEvent.click(screen.getByTestId("left-rail-demo-role-admin"));

    expect(screen.getByTestId("left-rail-icon-settings")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-icon-users")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-demo-role-admin")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("swaps the admin entries back out when the toggle returns to viewer", () => {
    setDemoRole("admin");
    renderWithShell(<LeftRail />);

    expect(screen.getByTestId("left-rail-icon-users")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("left-rail-demo-role-viewer"));

    expect(screen.queryByTestId("left-rail-icon-settings")).toBeNull();
    expect(screen.queryByTestId("left-rail-icon-users")).toBeNull();
  });
});
