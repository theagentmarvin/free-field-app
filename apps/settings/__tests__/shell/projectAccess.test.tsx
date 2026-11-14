// @vitest-environment jsdom
// apps/settings — Wave 9 project-access (spec §B) shell tests.
//
// Covers the entry picker, the in-view ICON button (replacing the
// per-view dropdown), and the switcher sheet's Leave-project, plus the
// hint helpers. The components under test receive `projects` via props,
// so no Firebase is needed; the gate harness runs inside the demo
// <AuthProvider> and exercises the wave-65 provider-owned current
// project (auto-pick → leave → picker → choose) as <MainShell> wires it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AuthProvider, useProjectSelection } from "@ff/auth";

import { ProjectAccessButton, ProjectEntryScreen } from "../../src/shell/ProjectAccess";
import {
  clearProjectChoice,
  readProjectChoice,
  writeProjectChoice,
  useAvailableProjects,
  useProjectChoice,
  PROJECT_CHOICE_KEY,
  type ProjectOption,
} from "../../src/shell/projectChoice";

const DEMO: ProjectOption = { id: "default-project", name: "Demo Tower", initials: "DT", meta: null };
const OTHER: ProjectOption = { id: "torre-norte", name: "Torre Norte", initials: "TN", meta: "12 floors · 2 open tasks" };

beforeEach(() => {
  localStorage.clear();
  clearProjectChoice();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllEnvs();
});

describe("project choice helpers", () => {
  it("round-trips a remembered choice through localStorage", () => {
    expect(readProjectChoice()).toBeNull();
    writeProjectChoice("p1");
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBe("p1");
    expect(readProjectChoice()).toBe("p1");
  });

  it("clearProjectChoice removes the key", () => {
    writeProjectChoice("p1");
    clearProjectChoice();
    expect(readProjectChoice()).toBeNull();
    expect(localStorage.getItem(PROJECT_CHOICE_KEY)).toBeNull();
  });

  it("is the @ff/auth hint key (the provider reads it once per sign-in)", () => {
    expect(PROJECT_CHOICE_KEY).toBe("ff-project-choice");
  });
});

describe("project entry screen", () => {
  it("shows the pick-once copy and lists projects", () => {
    render(<ProjectEntryScreen projects={[DEMO, OTHER]} currentId={null} onChoose={() => {}} />);
    expect(screen.getByText("Choose a project")).toBeInTheDocument();
    expect(screen.getByText("Demo Tower")).toBeInTheDocument();
    expect(screen.getByText("Torre Norte")).toBeInTheDocument();
  });

  it("marks the current project with a check and fires onChoose on tap", () => {
    const onChoose = vi.fn();
    render(<ProjectEntryScreen projects={[DEMO, OTHER]} currentId="default-project" onChoose={onChoose} />);
    const btn = screen.getByTestId("project-entry-option-default-project");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("project-entry-option-torre-norte"));
    expect(onChoose).toHaveBeenCalledWith("torre-norte");
  });
});

describe("project entry screen — empty state (wave 63)", () => {
  it("offers a sign-in link when signed out", () => {
    render(<ProjectEntryScreen projects={[]} currentId={null} onChoose={() => {}} signedIn={false} />);
    expect(screen.getByTestId("project-entry-empty").textContent).toMatch(/Sign in to see your projects/);
    expect(screen.getByTestId("project-entry-sign-in").getAttribute("href")).toBe("/sign-in");
  });

  it("explains a signed-in user has no project yet", () => {
    render(<ProjectEntryScreen projects={[]} currentId={null} onChoose={() => {}} />);
    expect(screen.getByTestId("project-entry-empty").textContent).toMatch(/access to a project/);
  });

  it("shows no empty state when projects exist", () => {
    render(<ProjectEntryScreen projects={[DEMO]} currentId={null} onChoose={() => {}} />);
    expect(screen.queryByTestId("project-entry-empty")).toBeNull();
  });
});

describe("<ErrorBoundary>", () => {
  it("resets itself when its resetKey changes (navigating away recovers)", async () => {
    const { ErrorBoundary } = await import("../../src/shell/ErrorBoundary");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let crash = true;
    function Maybe(): JSX.Element {
      if (crash) throw new Error("boom");
      return <div data-testid="ok" />;
    }
    const { rerender } = render(
      <ErrorBoundary label="Thing" resetKey="/a"><Maybe /></ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary").textContent).toMatch(/Thing ran into a problem/);
    crash = false;
    rerender(<ErrorBoundary label="Thing" resetKey="/b"><Maybe /></ErrorBoundary>);
    expect(screen.getByTestId("ok")).toBeTruthy();
    spy.mockRestore();
  });
});

describe("project access button (icon → switcher)", () => {
  it("icon button opens the switcher; the current project is checked", () => {
    render(<ProjectAccessButton projects={[DEMO, OTHER]} currentId="default-project" onSwitch={() => {}} onLeave={() => {}} />);
    fireEvent.click(screen.getByTestId("project-access-button"));
    expect(screen.getByTestId("project-switcher-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("project-switcher-option-default-project")).toHaveAttribute("aria-pressed", "true");
  });

  it("tapping a project in the switcher calls onSwitch", () => {
    const onSwitch = vi.fn();
    render(<ProjectAccessButton projects={[DEMO, OTHER]} currentId="default-project" onSwitch={onSwitch} onLeave={() => {}} />);
    fireEvent.click(screen.getByTestId("project-access-button"));
    fireEvent.click(screen.getByTestId("project-switcher-option-torre-norte"));
    expect(onSwitch).toHaveBeenCalledWith("torre-norte");
  });

  it("Leave project calls onLeave", () => {
    const onLeave = vi.fn();
    render(<ProjectAccessButton projects={[DEMO]} currentId="default-project" onSwitch={() => {}} onLeave={onLeave} />);
    fireEvent.click(screen.getByTestId("project-access-button"));
    fireEvent.click(screen.getByTestId("project-switcher-leave"));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("Escape or scrim closes the switcher", () => {
    render(<ProjectAccessButton projects={[DEMO]} currentId="default-project" onSwitch={() => {}} onLeave={() => {}} />);
    fireEvent.click(screen.getByTestId("project-access-button"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("project-switcher-sheet")).toBeNull();
  });
});

describe("provider-owned current project → picker gate (wave 65)", () => {
  function EntryHarness(): JSX.Element {
    const choice = useProjectChoice();
    const projects = useAvailableProjects();
    const { switchProject, setCurrentProject } = useProjectSelection();
    if (choice == null) {
      return <ProjectEntryScreen projects={projects} currentId={null} onChoose={switchProject} />;
    }
    return (
      <div>
        <div data-testid="entered">entered {choice}</div>
        <button data-testid="leave" onClick={() => setCurrentProject(null)} />
      </div>
    );
  }

  function renderGate() {
    vi.stubEnv("VITE_FF_DEMO_AUTH", "true");
    return render(
      <AuthProvider>
        <EntryHarness />
      </AuthProvider>,
    );
  }

  it("the single demo membership is entered without a picker", () => {
    renderGate();
    expect(screen.getByTestId("entered")).toHaveTextContent("entered default-project");
  });

  it("leave returns to the picker; choosing remembers the hint and enters", () => {
    renderGate();
    act(() => screen.getByTestId("leave").click());
    expect(screen.getByTestId("project-entry-screen")).toBeInTheDocument();
    expect(readProjectChoice()).toBeNull();

    fireEvent.click(screen.getByTestId("project-entry-option-default-project"));
    expect(screen.getByTestId("entered")).toHaveTextContent("entered default-project");
    expect(readProjectChoice()).toBe("default-project");
  });

  it("the demo option keeps its Demo Tower name", () => {
    renderGate();
    act(() => screen.getByTestId("leave").click());
    expect(screen.getByText("Demo Tower")).toBeInTheDocument();
  });
});
