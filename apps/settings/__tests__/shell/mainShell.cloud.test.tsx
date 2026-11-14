// apps/settings — <MainShell> routing in CLOUD mode (wave 63).
//
// Regression tests for the review findings:
//   - a signed-out visitor can reach /sign-in and /finish-sign-in (the
//     public auth routes render BEFORE the project gate);
//   - signed out + no project choice → redirected to /sign-in, never an
//     empty picker;
//   - signed in without any project → picker empty state with a link;
//   - module routes are lazy (Suspense) and wrapped in an error
//     boundary with Retry;
//   - demo mode enters the demo project without a picker (no setState
//     during render warning);
//   - wave 65: the current project comes from the provider (one
//     membership is auto-picked, several → picker), a project listener
//     error shows Retry, and the one-time local re-key fires for a
//     real project only.
//
// Every module and the auth layer are stubbed; only the shell's
// routing / gating logic is under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Navigate } from "react-router-dom";

const h = vi.hoisted(() => ({
  demo: false,
  loading: false,
  user: null as null | { uid: string; email: string; claims: { currentProject?: { id: string; role: string } } },
  project: null as null | { id: string; role: string; name?: string },
  /** undefined = memberships loading; default = derived from h.project. */
  memberships: undefined as undefined | Array<{ id: string; role: string; name?: string }>,
  membershipsSet: false,
  selected: null as string | null,
  projectError: null as Error | null,
  rekeyCalls: [] as Array<[string | null, string | null | undefined]>,
  documentsThrows: false,
}));

/** Mirrors @ff/auth's resolution: selected membership, else the single one. */
function selection() {
  const memberships = h.membershipsSet
    ? h.memberships
    : h.demo
      ? [{ id: "default-project", role: "viewer", name: "Demo project" }]
      : h.user
        ? h.project
          ? [h.project]
          : []
        : [];
  let currentProjectId: string | null | undefined;
  if (!h.demo && !h.user) currentProjectId = null;
  else if (memberships === undefined) currentProjectId = undefined;
  else if (h.selected && memberships.some((m) => m.id === h.selected)) currentProjectId = h.selected;
  else currentProjectId = memberships.length === 1 ? memberships[0].id : null;
  return { memberships, currentProjectId };
}

vi.mock("@ff/auth", () => {
  const useAuth = () => ({
    user: h.user,
    firebaseUser: null,
    loading: h.loading,
    error: undefined,
    signOut: async () => undefined,
    refreshClaims: async () => ({}),
  });
  return {
    DEMO_PROJECT_ID: "default-project",
    PROJECT_CHOICE_KEY: "ff-project-choice",
    readProjectHint: () => localStorage.getItem("ff-project-choice"),
    writeProjectHint: (id: string) => localStorage.setItem("ff-project-choice", id),
    clearProjectHint: () => localStorage.removeItem("ff-project-choice"),
    useProjectSelection: () => ({
      ...selection(),
      setCurrentProject: (id: string | null) => {
        h.selected = id;
        return true;
      },
      switchProject: (id: string) => {
        h.selected = id;
        return true;
      },
    }),
    useCurrentProjectState: () => ({ project: h.project, error: h.projectError, retry: () => undefined }),
    ProjectLoadError: ({ error }: { error: Error }) => <div data-testid="project-load-error">{error.message}</div>,
    isDemoAuth: () => h.demo,
    AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useAuth,
    useCurrentProject: () => h.project,
    useDemoRole: () => "viewer",
    useIsAdmin: () => h.user?.claims.currentProject?.role === "admin",
    useRole: () =>
      h.demo ? "viewer" : !h.user ? "anonymous" : h.user.claims.currentProject?.role === "admin" ? "admin" : "viewer",
    setDemoRole: () => undefined,
    RequireAdmin: ({ children }: { children: ReactNode }) =>
      h.user?.claims.currentProject?.role === "admin" ? <>{children}</> : <Navigate to="/documents" replace />,
    RequireProjectMember: ({ children }: { children: ReactNode }) =>
      h.loading ? null : h.user || h.demo ? <>{children}</> : <Navigate to="/sign-in" replace />,
  };
});

vi.mock("@free-field/models", async () => {
  const React = await import("react");
  return {
    PersistentViewerSurface: () => null,
    ViewerSurfaceHostContext: React.createContext<unknown>(null),
    useViewerSurfaceHost: () => ({ viewerRef: { current: null }, registerHost: () => undefined, surfaceLoaded: false }),
    useActiveBuilding: () => null,
    useBuildingOptions: () => [],
    BuildingIcon: () => null,
    BuildingSwitcher: () => null,
    ModelsApp: () => <div data-testid="models-app" />,
  };
});

vi.mock("@ff/tasks-react", async () => {
  const { tokens } = await import("../../../../packages/ff-tasks-react/src/formStyles");
  return {
    tokens,
    runDemoTasksSeedIfEmpty: async () => undefined,
    useTaskPhotoResolver: () => undefined,
    TasksApp: () => <div data-testid="tasks-app" />,
  };
});

vi.mock("@free-field/documents", () => ({
  DocumentsApp: () => {
    if (h.documentsThrows) throw new Error("documents exploded");
    return <div data-testid="documents-app" />;
  },
}));
vi.mock("@free-field/linkview", () => ({ LinkviewApp: () => <div data-testid="linkview-app" /> }));
vi.mock("@free-field/users", () => ({
  UsersApp: () => <div data-testid="users-app" />,
  SignInPage: () => <div data-testid="sign-in-page" />,
  FinishSignInPage: () => <div data-testid="finish-sign-in-page" />,
  NeedsInvitationPage: () => <div data-testid="needs-invitation-page" />,
}));
vi.mock("@components/App", () => ({ default: () => <div data-testid="settings-app" /> }));
vi.mock("../../src/seed/demoSeed", () => ({
  runDemoSeedIfEmpty: async () => "skipped",
  isDemoSeeding: () => false,
  subscribeDemoSeeding: () => () => undefined,
}));
vi.mock("../../src/seed/seedExport", () => ({ exportDemoSeedIfRequested: async () => undefined }));
vi.mock("../../src/shell/useLegacyProjectRekey", () => ({
  useLegacyProjectRekey: (uid: string | null, projectId: string | null | undefined) => {
    h.rekeyCalls.push([uid, projectId]);
  },
}));

import MainShell from "@shell/MainShell";
import { PROJECT_CHOICE_KEY } from "@shell/projectChoice";

function at(path: string): void {
  window.history.pushState({}, "", path);
}

const member = {
  uid: "u1",
  email: "m@x.test",
  claims: { currentProject: { id: "p1", role: "member" } },
};

beforeEach(() => {
  localStorage.clear();
  h.demo = false;
  h.loading = false;
  h.user = null;
  h.project = null;
  h.memberships = undefined;
  h.membershipsSet = false;
  h.selected = null;
  h.projectError = null;
  h.rekeyCalls = [];
  h.documentsThrows = false;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("<MainShell> cloud mode", () => {
  it("a signed-out visitor at / with no project choice is sent to /sign-in", async () => {
    at("/");
    render(<MainShell />);
    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/sign-in");
    expect(screen.queryByTestId("project-entry-screen")).toBeNull();
  });

  it("/finish-sign-in is reachable without a project choice", async () => {
    at("/finish-sign-in?oobCode=x");
    render(<MainShell />);
    expect(await screen.findByTestId("finish-sign-in-page")).toBeInTheDocument();
    expect(screen.queryByTestId("project-entry-screen")).toBeNull();
  });

  it("/sign-in is reachable even with a remembered project choice (no rail)", async () => {
    localStorage.setItem(PROJECT_CHOICE_KEY, "p1");
    h.selected = "p1";
    at("/sign-in");
    render(<MainShell />);
    expect(await screen.findByTestId("sign-in-page")).toBeInTheDocument();
    expect(screen.getByTestId("public-auth-shell")).toBeInTheDocument();
  });

  it("a signed-in user without projects sees the empty state with a sign-in link", () => {
    h.user = { uid: "u2", email: "n@x.test", claims: {} };
    at("/");
    render(<MainShell />);
    expect(screen.getByTestId("project-entry-empty")).toBeInTheDocument();
    expect(screen.getByTestId("project-entry-sign-in")).toHaveAttribute("href", "/sign-in");
  });

  it("renders nothing while auth is loading (no premature redirect)", () => {
    h.loading = true;
    at("/documents");
    render(<MainShell />);
    expect(window.location.pathname).toBe("/documents");
    expect(screen.queryByTestId("project-entry-screen")).toBeNull();
  });

  it("lazy-loads a module route for a member (single membership auto-picked)", async () => {
    h.user = member;
    h.project = { id: "p1", role: "member", name: "Tower" };
    at("/documents");
    render(<MainShell />);
    expect(await screen.findByTestId("documents-app")).toBeInTheDocument();
    expect(screen.getByTestId("left-rail-icon-sign-out")).toBeInTheDocument();
    // The one-time local re-key is asked for (uid, real project).
    expect(h.rekeyCalls).toContainEqual(["u1", "p1"]);
  });

  it("several memberships and no choice → the picker; choosing enters", async () => {
    h.user = member;
    h.membershipsSet = true;
    h.memberships = [
      { id: "p1", role: "member", name: "Tower" },
      { id: "p2", role: "member", name: "Annex" },
    ];
    at("/documents");
    const { rerender } = render(<MainShell />);
    expect(screen.getByTestId("project-entry-screen")).toBeInTheDocument();
    expect(screen.getByText("Annex")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("project-entry-option-p2"));
    expect(h.selected).toBe("p2");
    rerender(<MainShell />);
    expect(await screen.findByTestId("documents-app")).toBeInTheDocument();
    expect(h.rekeyCalls).toContainEqual(["u1", "p2"]);
  });

  it("renders nothing while memberships load, and Retry on a project listener error", () => {
    h.user = member;
    h.membershipsSet = true;
    h.memberships = undefined;
    at("/documents");
    const { rerender } = render(<MainShell />);
    expect(screen.queryByTestId("project-entry-screen")).toBeNull();
    expect(screen.queryByTestId("documents-app")).toBeNull();

    h.projectError = new Error("permission-denied");
    rerender(<MainShell />);
    expect(screen.getByTestId("project-load-error")).toHaveTextContent("permission-denied");
  });

  it("a crashing module shows an error boundary with Retry, the rail survives", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.user = member;
    h.project = { id: "p1", role: "member", name: "Tower" };
    h.documentsThrows = true;
    at("/documents");
    render(<MainShell />);

    expect(await screen.findByTestId("error-boundary")).toHaveTextContent("documents exploded");
    expect(screen.getByTestId("left-rail-icon-sign-out")).toBeInTheDocument();

    h.documentsThrows = false;
    fireEvent.click(screen.getByTestId("error-boundary-retry"));
    expect(await screen.findByTestId("documents-app")).toBeInTheDocument();
  });
});

describe("<MainShell> demo mode", () => {
  it("enters the demo project without a picker (no setState-in-render warning)", async () => {
    h.demo = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    at("/documents");
    render(<MainShell />);

    expect(screen.queryByTestId("project-entry-screen")).toBeNull();
    // Demo mode never asks for the local re-key.
    expect(h.rekeyCalls.every(([uid, pid]) => uid === null && pid === null)).toBe(true);
    expect(await screen.findByTestId("documents-app")).toBeInTheDocument();
    const renderWarnings = errors.mock.calls.filter((c) =>
      String(c[0]).includes("Cannot update a component"),
    );
    expect(renderWarnings).toHaveLength(0);
  });
});
