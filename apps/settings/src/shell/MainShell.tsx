import {
  Suspense,
  lazy,
  useEffect,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";

import { useViewerSurfaceHost } from "@free-field/models";
import { runDemoTasksSeedIfEmpty, useTaskPhotoResolver } from "@ff/tasks-react";
import {
  AuthProvider,
  ProjectLoadError,
  RequireAdmin,
  RequireProjectMember,
  isDemoAuth,
  useAuth,
  useCurrentProjectState,
  useProjectSelection,
} from "@ff/auth";
import { useIsMobile, useModelsToolStore } from "@ff/viewer-tools";
import { useActiveBuilding, useBuildingOptions } from "@free-field/models";

import LeftRail from "./LeftRail";
import { ViewerKeepAlive } from "./ViewerKeepAlive";
import { ProjectEntryScreen } from "./ProjectAccess";
import { ErrorBoundary } from "./ErrorBoundary";
import { DatabaseUpdateBanner } from "./DatabaseUpdateBanner";
import { resumePendingTileCachePurge } from "./signOut";
import { useAvailableProjects } from "./projectChoice";
import { useLegacyProjectRekey } from "./useLegacyProjectRekey";
import { useEnsureLocalProjectRow } from "./ensureLocalProjectRow";
import { ENTRY_ROUTE } from "./entryRoute";
import {
  isDemoSeeding,
  runDemoSeedIfEmpty,
  subscribeDemoSeeding,
} from "../seed/demoSeed";
import { exportDemoSeedIfRequested } from "../seed/seedExport";

// Wave 63 — route-level code splitting. Each module route loads its
// own chunk on first visit. The persistent viewer surface
// (<ViewerKeepAlive> → @free-field/models) stays eager: it must exist
// before the first /models | /linkview | /documents visit to keep the
// WebGL surface alive across module switches.
const SettingsApp = lazy(() => import("@components/App"));
const DocumentsApp = lazy(() =>
  import("@free-field/documents").then((m) => ({ default: m.DocumentsApp })),
);
const LinkviewApp = lazy(() =>
  import("@free-field/linkview").then((m) => ({ default: m.LinkviewApp })),
);
const ModelsApp = lazy(() =>
  import("@free-field/models").then((m) => ({ default: m.ModelsApp })),
);
const TasksApp = lazy(() =>
  import("@ff/tasks-react").then((m) => ({ default: m.TasksApp })),
);
const UsersApp = lazy(() =>
  import("@free-field/users").then((m) => ({ default: m.UsersApp })),
);
const SignInPage = lazy(() =>
  import("@free-field/users").then((m) => ({ default: m.SignInPage })),
);
const FinishSignInPage = lazy(() =>
  import("@free-field/users").then((m) => ({ default: m.FinishSignInPage })),
);
const NeedsInvitationPage = lazy(() =>
  import("@free-field/users").then((m) => ({ default: m.NeedsInvitationPage })),
);
const DevPickMultimodel = lazy(() => import("@components/DevPickMultimodel"));

/** Public auth routes: reachable without a project choice (wave 63). */
const PUBLIC_AUTH_PATHS = ["/sign-in", "/finish-sign-in", "/needs-invitation"];

/**
 * Top-level app shell for the unified FreeField app.
 *
 * Routes (plan v3 §2):
 *   Public:
 *     /sign-in           → email entry + signInWithEmailLink
 *     /finish-sign-in    → handles oobCode, completes sign-in, branches by claims
 *     /needs-invitation  → landing for signed-in users without project membership
 *
 *   Admin-only (<RequireAdmin>):
 *     /                  → Settings module (existing AppShell + ViewerPanel +
 *                          calibration wizard + PDF overlay — admin authoring)
 *     /users/*           → UsersApp (member list, invite, roles, audit — Phase 1)
 *
 *   Member consumption (<RequireProjectMember>):
 *     /documents         → PDF reader, project-scoped
 *     /models            → 3D viewer, read-only
 *     /linkview          → PDF ↔ IFC side-by-side
 *
 *   Catch-all:
 *     * → DefaultLanding: redirects based on auth state
 *         (admin → /, member → /documents, signed-out → /sign-in,
 *          signed-in w/o project → /needs-invitation)
 *
 * Architecture:
 *   <AuthProvider> at the root initializes Firebase exactly once and runs
 *   the tenant-check (plan v3 §10 P0.3): compares runtime Firebase project
 *   ID to the build manifest (VITE_EXPECTED_FIREBASE_PROJECT_ID) — refuses
 *   to start on mismatch.
 *
 * LeftRail filtering by role (admin sees Settings + Users; member doesn't)
 * is implemented in <LeftRail> via useRole().
 *
 * Demo mode (plan v4 amendment v4.1 — VITE_FF_DEMO_AUTH=true):
 *   - There is no sign-in. The public auth routes redirect to "/".
 *   - The default landing sends everyone to /models (entryRoute.ts).
 *   - The LeftRail carries the mocked sign-in ("View as: Viewer | Admin").
 */
const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  width: "100vw",
  overflow: "hidden",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

// Task 36 — mobile pass. The shell height moved OUT of the inline
// style and into the `.ff-main-shell` class (apps/settings/index.html)
// so the CSS can declare the fallback line FIRST and upgrade it:
//
//   .ff-main-shell { height: 100vh; }
//   @supports (height: 100dvh) { .ff-main-shell { height: 100dvh; } }
//
// `100dvh` tracks the mobile URL bar (the viewport shrinks when the
// bar slides in); `100vh` stays as the fallback for browsers without
// `dvh` support. On desktop the two are identical, so the desktop
// rendering is unchanged.
const mobileShellStyle: CSSProperties = {
  ...shellStyle,
  // Phones: the content area sits ON TOP and the navigation rail
  // becomes a bottom tab bar (see LeftRail.tsx).
  // Wave 35 review fix: this was `column` with <LeftRail /> as the
  // first child, which rendered the tab bar at the TOP — contradicting
  // the boss-validated constraint 8 ("rail stays bottom tab bar") and
  // the comment above. column-reverse puts the outlet on top and the
  // rail at the bottom without touching DOM order.
  flexDirection: "column-reverse",
};

const outletStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  position: "relative",
};

// Task 36 — phones only: keep the content clear of the home
// indicator / gesture bar at the bottom of the screen.
// Wave 35 review: with the shell now column-reverse, the outlet's
// bottom edge sits ABOVE the rail, so the safe-area inset belongs to
// the rail (mobileWrapperStyle already carries it), not the outlet.
const mobileOutletStyle: CSSProperties = {
  ...outletStyle,
};

export default function MainShell(): ReactNode {
  // A tile-cache purge left pending by a previous sign-out (the cache
  // DB was still held open by a worker) is retried on boot.
  useEffect(() => {
    void resumePendingTileCachePurge();
  }, []);

  return (
    <AuthProvider>
      {/* Wave 64 — "database updated in another tab" (replaces the
          confirm() fallback in @ff/data). */}
      <DatabaseUpdateBanner />
      <BrowserRouter>
        <ErrorBoundary label="FreeField">
          <ViewerKeepAlive>
            <ShellLayout />
          </ViewerKeepAlive>
        </ErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  );
}

/** Suspense fallback for a lazily loaded module route. */
function RouteLoading(): ReactNode {
  return (
    <div
      data-testid="route-loading"
      style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--ff-text-secondary)", fontSize: 13 }}
    >
      Loading…
    </div>
  );
}

/** One module route: error boundary (reset on navigation) + Suspense. */
function ModuleRoute({ label, children }: { label: string; children: ReactNode }): ReactNode {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary label={label} resetKey={pathname}>
      <Suspense fallback={<RouteLoading />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** Small non-blocking banner while the demo bundle is being written. */
function DemoSeedingBanner(): ReactNode {
  const seeding = useSyncExternalStore(subscribeDemoSeeding, isDemoSeeding, isDemoSeeding);
  if (!seeding) return null;
  return (
    <div
      role="status"
      data-testid="demo-seeding"
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        padding: "6px 14px",
        borderRadius: 999,
        background: "var(--ff-bg-app)",
        border: "1px solid var(--ff-border)",
        boxShadow: "0 2px 8px rgba(16,24,40,0.12)",
        fontSize: 13,
        color: "var(--ff-text-primary)",
        pointerEvents: "none",
      }}
    >
      Loading demo…
    </div>
  );
}

/**
 * The public auth pages, full-screen (no rail, no project gate). Demo
 * mode has no sign-in: they bounce back to the app root.
 */
function PublicAuthRoutes({ demo }: { demo: boolean }): ReactNode {
  return (
    <ModuleRoute label="Sign-in">
      <Routes>
        <Route path="/sign-in" element={demo ? <Navigate to="/" replace /> : <SignInPage />} />
        <Route
          path="/finish-sign-in"
          element={demo ? <Navigate to="/" replace /> : <FinishSignInPage />}
        />
        <Route
          path="/needs-invitation"
          element={demo ? <Navigate to="/" replace /> : <NeedsInvitationPage />}
        />
      </Routes>
    </ModuleRoute>
  );
}

function ShellLayout(): ReactNode {
  // Demo mode has no sign-in: the public auth pages are unreachable and
  // bounce back to the app root.
  const demo = isDemoAuth();
  const { pathname } = useLocation();
  const { user, loading } = useAuth();

  // Task-module row photo thumbs (VDC 2026-11-02): the resolver turns
  // a task doc's Storage path into a download URL. It is backed by the
  // same Storage instance the outbox engine uploads through, and it is
  // absent in demo mode — the rows then render exactly as before.
  const resolvePhotoUrl = useTaskPhotoResolver();

  // Task 36 — the single breakpoint primitive. On a phone the shell
  // flips to a COLUMN (content on top, navigation rail as a bottom
  // tab bar); on desktop it stays the exact row it has always been.
  const isMobile = useIsMobile();

  // Task 32 / wave 56 — first-boot demo seed (demo mode only, once per
  // page load). Fire-and-forget: the seeded state surfaces through the
  // Dexie live queries; <DemoSeedingBanner> shows "Loading demo…"
  // while it runs. A failure never blocks the boot.
  useEffect(() => {
    if (!demo) return;
    // Building/IFC/PDF seed first, then the task seed (reads the real
    // demo ids the first seed just wrote). Both are idempotent.
    void runDemoSeedIfEmpty().then(() => runDemoTasksSeedIfEmpty());
  }, [demo]);

  // Wave 56 — the `?ff-export-seed=1` dev tool re-exports the current
  // demo data as a fresh seed bundle (manifest.json + blobs). Demo mode
  // only, no-op on every normal page load.
  useEffect(() => {
    if (!demo) return;
    void exportDemoSeedIfRequested();
  }, [demo]);

  // Wave 52 — the shared viewer surface seam, provided by the
  // <ViewerKeepAlive> that wraps <ShellLayout>.
  const surfaceHost = useViewerSurfaceHost();

  // Wave 65 — project access: THE current project lives in
  // <AuthProvider> (validated against the memberships, cleared on
  // sign-out). A single membership is picked automatically; several →
  // the full-screen entry picker (also shown after "Leave project").
  const { currentProjectId: choice, switchProject, setCurrentProject } = useProjectSelection();
  const { project, error: projectError, retry: retryProject } = useCurrentProjectState();
  const projects = useAvailableProjects();
  const leaveProject = (): void => {
    setCurrentProject(null);
  };

  // Wave 65 — one-time move of pre-Phase-1 local rows ("default-project")
  // to the first real project chosen on this device. Never in demo mode.
  useLegacyProjectRekey(demo ? null : (user?.uid ?? null), demo ? null : choice);

  // Wave 66 — the ONE local `projects` row bootstrap (modules no longer
  // create their own). No-op in demo mode, where the demo seed writes it.
  useEnsureLocalProjectRow(demo ? null : choice, project?.name);

  // UI-refresh v1 §2 — /tasks is building-scoped. The host reads the
  // SAME shared store the rail + NavPanel use.
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const buildingOptions = useBuildingOptions(choice);
  const activeBuilding = useActiveBuilding(activeBuildingId, choice);

  const shellClass = "ff-app-shell ff-main-shell";
  const style = isMobile ? mobileShellStyle : shellStyle;

  // Wave 63 — the public auth routes come BEFORE the project gate, so
  // a signed-out visitor can reach /sign-in and /finish-sign-in.
  if (PUBLIC_AUTH_PATHS.includes(pathname)) {
    return (
      <div style={style} className={`${shellClass} ff-main-shell--auth`} data-testid="public-auth-shell">
        <div style={isMobile ? mobileOutletStyle : outletStyle} className="ff-app-shell__outlet">
          <PublicAuthRoutes demo={demo} />
        </div>
      </div>
    );
  }

  if (choice == null) {
    if (!demo) {
      // Cloud mode: wait for auth, and send a signed-out visitor to
      // sign in instead of showing an empty picker.
      if (loading) return null;
      if (!user) {
        return <Navigate to="/sign-in" replace state={{ from: pathname }} />;
      }
      if (projectError) {
        return <ProjectLoadError error={projectError} onRetry={retryProject} />;
      }
      // Memberships still loading.
      if (choice === undefined) return null;
    }
    return (
      <div
        style={style}
        className={`${shellClass} ff-main-shell--entry`}
        data-testid="project-entry-shell"
      >
        <ProjectEntryScreen
          projects={projects}
          currentId={null}
          onChoose={switchProject}
          signedIn={demo || !!user}
        />
      </div>
    );
  }

  return (
    <div style={style} className={shellClass}>
      <LeftRail
        projectAccess={{
          projects,
          currentId: choice,
          onSwitch: switchProject,
          onLeave: leaveProject,
        }}
      />
      <div
        style={isMobile ? mobileOutletStyle : outletStyle}
        className="ff-app-shell__outlet"
      >
        {demo ? <DemoSeedingBanner /> : null}
        {/* Wave 52 — the persistent viewer surface lives in
            <ViewerKeepAlive> (which wraps this whole shell) and
            portals into whichever route's slot is active. */}
        <Routes>
          {/* Admin-only routes */}
          <Route
            path="/"
            element={
              <RequireAdmin>
                <ModuleRoute label="Settings">
                  <SettingsApp />
                </ModuleRoute>
              </RequireAdmin>
            }
          />
          <Route
            path="/users/*"
            element={
              <RequireAdmin>
                <ModuleRoute label="Users">
                  <UsersApp />
                </ModuleRoute>
              </RequireAdmin>
            }
          />

          {/* Member consumption routes */}
          <Route
            path="/documents"
            element={
              <RequireProjectMember>
                <ModuleRoute label="Documents">
                  <DocumentsApp
                    viewerRef={surfaceHost.viewerRef}
                    registerHost={surfaceHost.registerHost}
                  />
                </ModuleRoute>
              </RequireProjectMember>
            }
          />
          {/* Wave 52: the 3D surface is rendered by the persistent
              kernel; this route keeps the Models chrome registered and
              ports the surface into its viewport slot. */}
          <Route
            path="/models"
            element={
              <RequireProjectMember>
                <ModuleRoute label="Models">
                  <ModelsApp
                    viewerRef={surfaceHost.viewerRef}
                    registerHost={surfaceHost.registerHost}
                  />
                </ModuleRoute>
              </RequireProjectMember>
            }
          />
          <Route
            path="/linkview"
            element={
              <RequireProjectMember>
                <ModuleRoute label="Linkview">
                  <LinkviewApp
                    viewerRef={surfaceHost.viewerRef}
                    registerHost={surfaceHost.registerHost}
                    surfaceLoaded={surfaceHost.surfaceLoaded}
                  />
                </ModuleRoute>
              </RequireProjectMember>
            }
          />
          {/* Tasks module (plan D1): building-scoped via the rail's
              active building. */}
          <Route
            path="/tasks"
            element={
              <RequireProjectMember>
                <ModuleRoute label="Tasks">
                  <TasksApp
                    resolvePhotoUrl={resolvePhotoUrl}
                    buildingId={activeBuildingId}
                    buildingName={activeBuilding?.name ?? null}
                    buildings={buildingOptions.map((b) => ({ id: b.id, name: b.name }))}
                  />
                </ModuleRoute>
              </RequireProjectMember>
            }
          />

          {/* Wave 19: DEV-only multi-model pick bench. Never wired into
              production — `import.meta.env.DEV` is false in any build. */}
          {import.meta.env.DEV ? (
            <Route
              path="/dev/pick-multimodel"
              element={
                <ModuleRoute label="Dev bench">
                  <DevPickMultimodel />
                </ModuleRoute>
              }
            />
          ) : null}
          {/* Catch-all: route by auth state */}
          <Route path="*" element={<DefaultLanding />} />
        </Routes>
      </div>
    </div>
  );
}

/**
 * Smart default landing for unmatched routes (and the implicit entry point).
 * Branches by sign-in state + role + project membership.
 *
 * Demo mode: there is no sign-in, so every visitor lands on /models
 * (never /sign-in). Signed-in users also land on /models, whatever the
 * role — see entryRoute.ts for why the viewer comes first.
 */
function DefaultLanding(): ReactNode {
  const { user, loading } = useAuth();
  const { memberships } = useProjectSelection();

  if (isDemoAuth()) {
    return <Navigate to={ENTRY_ROUTE} replace />;
  }

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  // Phase 1b: memberships come from the member docs (not the token claim).
  if (memberships === undefined) {
    return null;
  }

  // Signed in but no project membership — self-invite or pending accept.
  if (memberships.length === 0) {
    return <Navigate to="/needs-invitation" replace />;
  }

  // Everyone lands in the Models viewer; admins reach Settings from the rail.
  return <Navigate to={ENTRY_ROUTE} replace />;
}