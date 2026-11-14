// @vitest-environment jsdom
// apps/settings — wave 39 combined project+building switcher tests.
//
// Renders <LeftRail> with the shell's `projectAccess` wiring (the
// combined entry) and verifies:
//   - the entry renders on EVERY route;
//   - the caption is the project short name on non-building routes
//     (and falls back to "PROJ" when no project resolves);
//   - the ONE frosted dropdown shows a PROJECT section everywhere and
//     a BUILDING section only on building-scoped routes;
//   - project switch / leave fire the shell callbacks; Escape + outside
//     click close.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { AuthProvider, setDemoRole } from "@ff/auth";
import { useModelsToolStore } from "@ff/viewer-tools";

import LeftRail, { type ProjectAccess } from "@shell/LeftRail";

const PROJECTS = [
  { id: "default-project", name: "Demo Tower", initials: "DT", meta: null },
  { id: "torre-norte", name: "Torre Norte", initials: "TN", meta: null },
] as const;

function makeAccess(over: Partial<ProjectAccess> = {}): ProjectAccess {
  return {
    projects: PROJECTS,
    currentId: "default-project",
    onSwitch: vi.fn(),
    onLeave: vi.fn(),
    ...over,
  };
}

function renderRail(path: string, projectAccess?: ProjectAccess) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <LeftRail projectAccess={projectAccess} />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_FF_DEMO_AUTH", "true");
  localStorage.clear();
  setDemoRole("viewer");
  useModelsToolStore.setState({ activeBuildingId: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe("combined project+building switcher", () => {
  it("renders the combined entry on the settings route with the project caption", () => {
    renderRail("/", makeAccess());

    // Entry present (both the legacy and combined testids).
    expect(screen.getByTestId("left-rail-building")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-combined")).toBeInTheDocument();

    // Caption = project short name ("Demo Tower" → "TOWER").
    expect(screen.getByTestId("left-rail-building")).toHaveTextContent(
      "TOWER",
    );
  });

  it("falls back to PROJ when no project name resolves", () => {
    renderRail("/", makeAccess({ currentId: "missing-project" }));

    expect(screen.getByTestId("left-rail-building")).toHaveTextContent(
      "PROJ",
    );
  });

  it("opens a PROJECT-only dropdown on the settings route", () => {
    renderRail("/", makeAccess());

    fireEvent.click(screen.getByTestId("left-rail-building"));

    expect(screen.getByTestId("combined-switcher")).toBeInTheDocument();
    expect(
      screen.getByTestId("combined-switcher-project-header"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("combined-switcher-project-default-project"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByTestId("combined-switcher-project-torre-norte"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("combined-switcher-leave")).toBeInTheDocument();

    // No building section off the building-scoped routes.
    expect(
      screen.queryByTestId("combined-switcher-building-header"),
    ).toBeNull();
    expect(screen.queryByTestId("combined-switcher-divider")).toBeNull();
  });

  it("shows the BUILDING section on the models route", () => {
    renderRail("/models", makeAccess());

    fireEvent.click(screen.getByTestId("left-rail-building"));

    expect(
      screen.getByTestId("combined-switcher-project-header"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("combined-switcher-building-header"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("combined-switcher-divider"),
    ).toBeInTheDocument();
  });

  it("shows the BUILDING section on the tasks route (UI-refresh v1)", () => {
    renderRail("/tasks", makeAccess());

    fireEvent.click(screen.getByTestId("left-rail-building"));

    expect(
      screen.getByTestId("combined-switcher-building-header"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("combined-switcher-divider"),
    ).toBeInTheDocument();
  });

  it("calls onSwitch when a different project is picked", () => {
    const onSwitch = vi.fn();
    renderRail("/", makeAccess({ onSwitch }));

    fireEvent.click(screen.getByTestId("left-rail-building"));
    fireEvent.click(
      screen.getByTestId("combined-switcher-project-torre-norte"),
    );

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith("torre-norte");
  });

  it("calls onLeave from the Leave project row", () => {
    const onLeave = vi.fn();
    renderRail("/", makeAccess({ onLeave }));

    fireEvent.click(screen.getByTestId("left-rail-building"));
    fireEvent.click(screen.getByTestId("combined-switcher-leave"));

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    renderRail("/", makeAccess());

    fireEvent.click(screen.getByTestId("left-rail-building"));
    expect(screen.getByTestId("combined-switcher")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("combined-switcher")).toBeNull();
  });

  it("closes on an outside click", () => {
    renderRail("/", makeAccess());

    fireEvent.click(screen.getByTestId("left-rail-building"));
    expect(screen.getByTestId("combined-switcher")).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByTestId("combined-switcher")).toBeNull();
  });
});