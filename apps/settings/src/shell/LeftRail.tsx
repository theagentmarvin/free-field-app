import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Link as RouterLink, useLocation } from "react-router-dom";
import { Box, CheckSquare, Group, Link, LogOut, Page, Settings } from "iconoir-react";

import { isDemoAuth, isDemoReadOnly, setDemoRole, useAuth, useRole } from "@ff/auth";
import { useIsMobile, useModelsToolStore } from "@ff/viewer-tools";
import { BuildingSwitcher, useActiveBuilding } from "@free-field/models";
import FreeFieldMark from "./FreeFieldMark";
import LeftRailIcon from "./LeftRailIcon";
import { type ProjectOption } from "./projectChoice";
import { signOutAndClear } from "./signOut";

/** The project-access surface the shell threads into the rail. */
export interface ProjectAccess {
  projects: readonly ProjectOption[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onLeave: () => void;
}

export interface LeftRailProps {
  /**
   * When wired (by the shell), the rail-start entry becomes a
   * combined project + building switcher. When undefined (isolated
   * tests), the entry falls back to the wave-35 building-only
   * switcher so <LeftRail> stays unit-testable on its own.
   */
  projectAccess?: ProjectAccess;
}

/**
 * Left rail (far-left vertical icon bar). 64px wide, white background.
 * Active icon uses --ff-blue-active.
 *
 * Per plan v3 §7.1, role-aware visibility:
 *   admin:    Settings / Documents / Models / Linkview / Users
 *   member:   Documents / Models / Linkview
 *   signed-out: rail hidden entirely (public auth pages show full-width)
 *
 * Layout (preserved from the original design):
 *   Top group (flex: 1):    consumption routes (Documents, Models, Linkview)
 *   Bottom group:           admin authoring routes (Settings, Users)
 *
 * Active state is derived from `useLocation()` — clicking an icon
 * updates the route via react-router, the icon lights up, and the
 * matching module renders in the outlet.
 *
 * Demo mode (plan v4 amendment v4.1): the rail also carries the mocked
 * sign-in — a compact "View as: Viewer | Admin" switch at the bottom.
 * Flipping it re-renders the whole nav (and the admin-only entries
 * appear/disappear) without ever touching Firebase.
 */
type RailItem = {
  to: string;
  label: string;
  icon: JSX.Element;
  adminOnly: boolean;
};

const ITEMS: RailItem[] = [
  // Top group — member consumption (visible to all signed-in users)
  { to: "/models", label: "Models", icon: <Box />, adminOnly: false },
  { to: "/documents", label: "Documents", icon: <Page />, adminOnly: false },
  { to: "/linkview", label: "Linkview", icon: <Link />, adminOnly: false },
  { to: "/tasks", label: "Tasks", icon: <CheckSquare />, adminOnly: false },
  // Bottom group — admin authoring (admin only)
  { to: "/", label: "Settings", icon: <Settings />, adminOnly: true },
  { to: "/users", label: "Users", icon: <Group />, adminOnly: true },
];

type ActiveRoute = "settings" | "models" | "documents" | "linkview" | "tasks" | "users";

/**
 * Wave 35 (toolbar-nav redesign) — the routes whose module is scoped
 * to ONE building. The BUILDING section of the combined switcher only
 * makes sense there; on the admin surfaces (Settings / Users) it hides.
 *
 * Models + Documents (wave 39) share the building dimension via the
 * module rail's combined switcher. Tasks (UI-refresh v1, boss-approved)
 * is building-scoped too: the rail's BUILDING section shows on /tasks
 * and its choice drives the task list's scope.
 */
const BUILDING_SCOPED_ROUTES = ["/models", "/documents", "/tasks"];

/**
 * The 8px uppercase caption under the rail's building icon — the
 * building's SHORT name ("Data Tower" → "TOWER").
 */
function buildingShortName(name: string | null): string {
  if (!name) return "";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const last = words.length > 1 ? words[words.length - 1]! : words[0]!;
  return last.toUpperCase().slice(0, 10);
}

/**
 * The project short-name caption for the combined switcher (same
 * `buildingShortName` transform). Never empty — "PROJ" when no
 * project name resolves.
 */
function projectShortName(projectAccess: ProjectAccess | undefined): string {
  if (!projectAccess) return "PROJ";
  const current = projectAccess.projects.find(
    (p) => p.id === projectAccess.currentId,
  );
  return buildingShortName(current?.name ?? null) || "PROJ";
}

export default function LeftRail({
  projectAccess,
}: LeftRailProps): JSX.Element | null {
  const { pathname } = useLocation();
  const { user, loading, signOut } = useAuth();
  const role = useRole();
  const demo = isDemoAuth();

  // Wave 63 — "Sign out" (real mode only; the demo has no sign-in).
  // Clears the project choice, the sign-in email key and the tile
  // cache, then reloads on /sign-in so no in-memory geometry or
  // worker-held cache connection survives for the next user.
  const [signingOut, setSigningOut] = useState(false);
  const handleSignOut = (): void => {
    if (signingOut) return;
    setSigningOut(true);
    void signOutAndClear(signOut)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[LeftRail] sign-out failed", err);
      })
      .finally(() => {
        window.location.assign("/sign-in");
      });
  };

  // Task 36 — phones render the rail as a bottom tab bar.
  const isMobile = useIsMobile();

  // Active state: route-derived, used to highlight the matching icon.
  // Pure pathname check so query strings don't confuse us.
  const activeRoute: ActiveRoute = useMemo(() => {
    if (pathname === "/models" || pathname.startsWith("/models/")) return "models";
    if (pathname === "/documents" || pathname.startsWith("/documents/")) return "documents";
    if (pathname === "/linkview" || pathname.startsWith("/linkview/")) return "linkview";
    if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return "tasks";
    if (pathname === "/users" || pathname.startsWith("/users/")) return "users";
    return "settings";
  }, [pathname]);

  // ── Wave 35/39: the combined switcher entry ──────────────────────
  // Pinned ABOVE the module icons, separated by a hairline. It runs on
  // EVERY route now (project switching is global); only the BUILDING
  // section of the dropdown is route-gated.
  const isBuildingScoped = useMemo(
    () =>
      BUILDING_SCOPED_ROUTES.some(
        (r) => pathname === r || pathname.startsWith(`${r}/`),
      ),
    [pathname],
  );

  // With `projectAccess` (the shell) the combined entry renders on
  // every route. Without it (isolated tests) fall back to the
  // building-only wave-35 entry, route-gated to building-scoped.
  const showEntry = projectAccess !== undefined || isBuildingScoped;

  // While auth is initializing OR user is signed out, hide the rail.
  // Signed-out users land on /sign-in (full-page, no rail).
  // Members navigating to /sign-in for some reason also see no rail.
  // Demo mode always has a (synthetic) signed-in user, so the rail shows.
  if (loading) return null;
  if (!user) return null;

  const isAdmin = role === "admin";

  const visibleTopItems = ITEMS.filter((i) => !i.adminOnly);
  const visibleBottomItems = isAdmin
    ? ITEMS.filter((i) => i.adminOnly)
    : [];

  const wrapperStyle: CSSProperties = {
    width: "var(--ff-left-rail-width)",
    flexShrink: 0,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "var(--ff-bg-app)",
    borderRight: "1px solid var(--ff-border)",
    paddingTop: 8,
    paddingBottom: 8,
  };

  const topContainerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    // 8px horizontal padding so each icon's active highlight
    // is inset from the rail edge. Lives here (not on
    // <LeftRailIcon>) because the icon uses `width: 100%` and
    // any horizontal margin there would overflow the 64px rail
    // and get clipped by the shell's `overflow: hidden`,
    // shifting the icon visibly to the right.
    padding: "0 8px",
  };

  const bottomContainerStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    padding: "0 8px",
  };

  // Task 36 — phones: the vertical rail becomes a BOTTOM TAB BAR.
  // Same items, same test ids, same active accent — only the
  // geometry changes (row instead of column, label under the icon).
  if (isMobile) {
    return (
      <>
        <nav
          style={mobileWrapperStyle}
          className="ff-left-rail ff-left-rail--tabbar"
          aria-label="FreeField navigation"
        >
          <div style={mobileItemsStyle}>
            {showEntry && (
              <RailCombinedSwitcher
                variant="tab"
                projectAccess={projectAccess}
                isBuildingScoped={isBuildingScoped}
              />
            )}
            {visibleTopItems.map((item) => (
              <MobileTabItem
                key={item.to}
                icon={item.icon}
                label={item.label}
                to={item.to}
                active={activeRoute === item.label.toLowerCase()}
              />
            ))}
            {visibleBottomItems.map((item) => (
              <MobileTabItem
                key={item.to}
                icon={item.icon}
                label={item.label}
                to={item.to}
                active={activeRoute === item.label.toLowerCase()}
              />
            ))}
          </div>
          {demo && !isDemoReadOnly() && (
            <DemoRoleSwitch
              role={role === "admin" ? "admin" : "viewer"}
              variant="pill"
            />
          )}
          {!demo && (
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label="Sign out"
              data-testid="left-rail-icon-sign-out"
              style={{ ...mobileTabStyle(false), border: "none", background: "transparent", cursor: "pointer" }}
            >
              <span style={mobileTabIconStyle}>
                <LogOut />
              </span>
              <span style={mobileTabLabelStyle}>Sign out</span>
            </button>
          )}
        </nav>
      </>
    );
  }

  return (
    <>
      <nav style={wrapperStyle} className="ff-left-rail" aria-label="FreeField navigation">
        {showEntry && (
          <>
            <div style={buildingEntryContainerStyle}>
              <RailCombinedSwitcher
                variant="rail"
                projectAccess={projectAccess}
                isBuildingScoped={isBuildingScoped}
              />
            </div>
            <div style={railDividerStyle} aria-hidden />
          </>
        )}
        <div style={topContainerStyle}>
          {visibleTopItems.map((item) => (
            <LeftRailIcon
              key={item.to}
              icon={item.icon}
              label={item.label}
              to={item.to}
              active={activeRoute === item.label.toLowerCase()}
            />
          ))}
        </div>
        {visibleBottomItems.length > 0 && (
          <div style={bottomContainerStyle}>
            {visibleBottomItems.map((item) => (
              <LeftRailIcon
                key={item.to}
                icon={item.icon}
                label={item.label}
                to={item.to}
                active={activeRoute === item.label.toLowerCase()}
              />
            ))}
          </div>
        )}
        {demo && !isDemoReadOnly() && <DemoRoleSwitch role={role === "admin" ? "admin" : "viewer"} />}
        {!demo && (
          <div style={bottomContainerStyle} title={user.email ?? undefined}>
            <LeftRailIcon icon={<LogOut />} label="Sign out" onClick={handleSignOut} />
          </div>
        )}
      </nav>
    </>
  );
}

/**
 * Wave 39 — the rail-start combined switcher (icon + dropdown).
 *
 * Owns the shared store's active building, the live building list
 * (for the 8px short-name caption) and the dropdown state. Renders on
 * EVERY route: the caption is the building short name on
 * building-scoped routes, otherwise the project short name.
 *
 * The dropdown is ONE frosted panel. When `projectAccess` is wired it
 * shows a PROJECT section (always) + a BUILDING section (building-
 * scoped routes only); every individual projection walks the shared store / the shell's callbacks. When
 * `projectAccess` is undefined (isolated tests) it falls back to the
 * wave-35 building-only <BuildingSwitcher>.
 */
function RailCombinedSwitcher({
  variant,
  projectAccess,
  isBuildingScoped,
}: {
  variant: "rail" | "tab";
  projectAccess: ProjectAccess | undefined;
  isBuildingScoped: boolean;
}): JSX.Element {
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore(
    (s) => s.setActiveBuildingId,
  );
  // Wave 65: the shell's current project (THE @ff/auth currentProjectId).
  const activeBuilding = useActiveBuilding(activeBuildingId, projectAccess?.currentId ?? null);
  const [open, setOpen] = useState(false);

  const caption = isBuildingScoped
    ? buildingShortName(activeBuilding?.name ?? null)
    : projectShortName(projectAccess);
  const showDot = isBuildingScoped && activeBuilding !== null;

  const trigger =
    variant === "rail" ? (
      <BuildingRailEntry
        shortName={caption}
        hasBuilding={showDot}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
    ) : (
      <BuildingTabEntry
        shortName={caption}
        hasBuilding={showDot}
        open={open}
        onToggle={() => setOpen((o) => !o)}
      />
    );

  return (
    <>
      {trigger}
      {open &&
        (projectAccess ? (
          <CombinedSwitcherDropdown
            projects={projectAccess.projects}
            currentId={projectAccess.currentId}
            onSwitch={(id) => {
              projectAccess.onSwitch(id);
              setOpen(false);
            }}
            onLeave={() => {
              projectAccess.onLeave();
              setOpen(false);
            }}
            activeBuildingId={activeBuildingId}
            onBuildingChange={setActiveBuildingId}
            showBuilding={isBuildingScoped}
            onClose={() => setOpen(false)}
            style={variant === "rail" ? desktopSwitcherStyle : mobileSwitcherStyle}
          />
        ) : (
          <BuildingSwitcher
            activeBuildingId={activeBuildingId}
            onBuildingChange={setActiveBuildingId}
            onPicked={() => setOpen(false)}
            onClose={() => setOpen(false)}
            style={variant === "rail" ? desktopSwitcherStyle : mobileSwitcherStyle}
          />
        ))}
    </>
  );
}

/**
 * The ONE frosted dropdown: a PROJECT section (icon-free rows +
 * checkmark + "Leave project") and, on building-scoped routes, a
 * BUILDING section reusing the wave-35 <BuildingSwitcher> rows.
 */
function CombinedSwitcherDropdown({
  projects,
  currentId,
  onSwitch,
  onLeave,
  activeBuildingId,
  onBuildingChange,
  showBuilding,
  onClose,
  style,
}: {
  projects: readonly ProjectOption[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onLeave: () => void;
  activeBuildingId: string | null;
  onBuildingChange: (id: string) => void;
  showBuilding: boolean;
  onClose: () => void;
  style?: CSSProperties;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  // Outside click + Escape close. Only one combined panel exists.
  useEffect(() => {
    function onPointerDown(e: PointerEvent): void {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={containerRef}
      className="ff-frosted ff-combined-switcher"
      data-testid="combined-switcher"
      role="dialog"
      aria-label="Switch project or building"
      style={{ ...combinedPanelStyle, ...style }}
    >
      <div style={sectionHeaderRow} data-testid="combined-switcher-project-header">
        Project
      </div>
      {projects.map((p) => {
        const current = p.id === currentId;
        return (
          <button
            key={p.id}
            type="button"
            data-testid={`combined-switcher-project-${p.id}`}
            aria-pressed={current}
            onClick={() => onSwitch(p.id)}
            style={projectRowStyle(current)}
          >
            <span style={projectRowLabelStyle}>{p.name}</span>
            {current && <CheckMark />}
          </button>
        );
      })}
      <button
        type="button"
        data-testid="combined-switcher-leave"
        onClick={onLeave}
        style={leaveRowStyle}
      >
        Leave project
      </button>

      {showBuilding && (
        <>
          <div style={hairlineStyle} aria-hidden data-testid="combined-switcher-divider" />
          <div
            style={sectionHeaderRow}
            data-testid="combined-switcher-building-header"
          >
            Building
          </div>
          <BuildingSwitcher
            bare
            activeBuildingId={activeBuildingId}
            onBuildingChange={onBuildingChange}
            onPicked={onClose}
            onClose={onClose}
          />
        </>
      )}
    </div>
  );
}

function CheckMark(): JSX.Element {
  return (
    <span aria-hidden style={checkMarkStyle}>
      ✓
    </span>
  );
}

/**
 * Wave 35 — the rail's building switcher icon (desktop).
 *
 * The FreeField brand mark + a teal dot when a building is active + the
 * 8px uppercase short-name caption. Clicking it opens the dropdown
 * to the right of the rail.
 */
function BuildingRailEntry({
  shortName,
  hasBuilding,
  open,
  onToggle,
}: {
  shortName: string;
  hasBuilding: boolean;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <span data-testid="left-rail-combined" style={{ display: "contents" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch project or building"
        title="Switch project or building"
        data-testid="left-rail-building"
        style={buildingEntryStyle}
      >
        <span style={buildingIconWrapStyle}>
          <FreeFieldMark />
          {hasBuilding && <span style={buildingDotStyle} aria-hidden />}
        </span>
        <span style={buildingCaptionStyle}>{shortName}</span>
      </button>
    </span>
  );
}

/**
 * Wave 35 — the phone variant: the building switcher rides along as
 * the FIRST tab of the bottom tab bar.
 */
function BuildingTabEntry({
  shortName,
  hasBuilding,
  open,
  onToggle,
}: {
  shortName: string;
  hasBuilding: boolean;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  return (
    <span data-testid="left-rail-combined" style={{ display: "contents" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch project or building"
        data-testid="left-rail-building"
        style={mobileTabStyle(false)}
      >
        <span style={{ ...mobileTabIconStyle, position: "relative" }}>
          <FreeFieldMark />
          {hasBuilding && <span style={buildingDotStyle} aria-hidden />}
        </span>
        <span style={mobileTabLabelStyle}>{shortName || "Building"}</span>
      </button>
    </span>
  );
}

/**
 * Task 36 — one entry in the phone tab bar: the module icon with its
 * label underneath (10px). Mirrors <LeftRailIcon>'s contract — same
 * `data-testid`, same `aria-label`, same `aria-current` — so tests
 * and screen readers see the same affordances on both layouts.
 */
function MobileTabItem({
  icon,
  label,
  to,
  active,
}: {
  icon: JSX.Element;
  label: string;
  to: string;
  active: boolean;
}): JSX.Element {
  const testId = `left-rail-icon-${label.toLowerCase().replace(/\s+/g, "-")}`;

  return (
    <RouterLink
      to={to}
      style={mobileTabStyle(active)}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      data-testid={testId}
    >
      <span style={mobileTabIconStyle}>{icon}</span>
      <span style={mobileTabLabelStyle}>{label}</span>
    </RouterLink>
  );
}

/**
 * The mocked sign-in. A compact "View as" switch at the bottom of the
 * rail — the demo equivalent of signing in as an admin. It is only
 * rendered in demo mode; in the real app the role comes from Firebase
 * claims.
 *
 * Task 36 — on phones the rail is a bottom tab bar, so the switch
 * collapses into a compact `Viewer | Admin` PILL that sits at the END
 * of the bar (right side). Same test ids, same `aria-pressed`.
 */
function DemoRoleSwitch({
  role,
  variant = "stack",
}: {
  role: "viewer" | "admin";
  variant?: "stack" | "pill";
}) {
  if (variant === "pill") {
    return (
      <div
        style={pillWrapperStyle}
        data-testid="left-rail-demo-switch"
        aria-label="View as"
        role="group"
      >
        <button
          type="button"
          onClick={() => setDemoRole("viewer")}
          aria-pressed={role === "viewer"}
          aria-label="View as viewer"
          data-testid="left-rail-demo-role-viewer"
          style={pillButtonStyle(role === "viewer")}
        >
          Viewer
        </button>
        <button
          type="button"
          onClick={() => setDemoRole("admin")}
          aria-pressed={role === "admin"}
          aria-label="View as admin"
          data-testid="left-rail-demo-role-admin"
          style={pillButtonStyle(role === "admin")}
        >
          Admin
        </button>
      </div>
    );
  }

  const wrapperStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: 2,
    padding: "8px 8px 0",
    borderTop: "1px solid var(--ff-border)",
    marginTop: 8,
  };

  const labelStyle: CSSProperties = {
    fontSize: 9,
    lineHeight: "12px",
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    color: "var(--ff-text-secondary)",
  };

  const buttonStyle = (active: boolean): CSSProperties => ({
    fontSize: 10,
    lineHeight: "16px",
    padding: "1px 0",
    border: "1px solid var(--ff-border)",
    borderRadius: 4,
    cursor: "pointer",
    background: active ? "var(--ff-blue-active)" : "transparent",
    color: active ? "#fff" : "var(--ff-text-secondary)",
    fontWeight: active ? 600 : 400,
  });

  return (
    <div style={wrapperStyle} data-testid="left-rail-demo-switch">
      <span style={labelStyle}>View as</span>
      <button
        type="button"
        onClick={() => setDemoRole("viewer")}
        aria-pressed={role === "viewer"}
        aria-label="View as viewer"
        data-testid="left-rail-demo-role-viewer"
        style={buttonStyle(role === "viewer")}
      >
        Viewer
      </button>
      <button
        type="button"
        onClick={() => setDemoRole("admin")}
        aria-pressed={role === "admin"}
        aria-label="View as admin"
        data-testid="left-rail-demo-role-admin"
        style={buttonStyle(role === "admin")}
      >
        Admin
      </button>
    </div>
  );
}

// ── Task 36 — phone (bottom tab bar) styles ─────────────────────
/**
 * The tab bar itself. 56px of bar + the device's bottom safe area
 * (home indicator / gesture bar) as padding, so the icons never
 * sit under the system UI.
 */
const mobileWrapperStyle: CSSProperties = {
  width: "100%",
  flexShrink: 0,
  height: "calc(56px + env(safe-area-inset-bottom, 0px))",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  background: "var(--ff-bg-app)",
  borderTop: "1px solid var(--ff-border)",
  paddingTop: 2,
  paddingBottom: "env(safe-area-inset-bottom, 0px)",
  paddingLeft: 2,
  paddingRight: 4,
};

/** The evenly-spaced row of module tabs. */
const mobileItemsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "stretch",
  justifyContent: "space-evenly",
  flex: 1,
  minWidth: 0,
  height: "100%",
};

/** One tab: icon on top, label underneath. */
const mobileTabStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 1,
  flex: "1 1 0",
  minWidth: 0,
  maxWidth: 110,
  height: "100%",
  color: active ? "var(--ff-blue-active)" : "var(--ff-text-secondary)",
  background: active ? "rgba(37, 99, 235, 0.08)" : "transparent",
  borderRadius: 6,
  textDecoration: "none",
  cursor: "pointer",
});

const mobileTabIconStyle: CSSProperties = {
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

const mobileTabLabelStyle: CSSProperties = {
  fontSize: 10,
  lineHeight: "12px",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "center",
};

/** The compact `Viewer | Admin` pill at the end of the tab bar. */
const pillWrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  flexShrink: 0,
  height: 28,
  marginLeft: 4,
  border: "1px solid var(--ff-border)",
  borderRadius: 14,
  overflow: "hidden",
  background: "var(--ff-bg-app)",
};

const pillButtonStyle = (active: boolean): CSSProperties => ({
  fontSize: 11,
  lineHeight: "26px",
  height: 26,
  padding: "0 8px",
  border: "none",
  cursor: "pointer",
  background: active ? "var(--ff-blue-active)" : "transparent",
  color: active ? "#fff" : "var(--ff-text-secondary)",
  fontWeight: active ? 600 : 400,
  whiteSpace: "nowrap",
});

// ── Wave 35 — the building switcher entry ─────────────────────────

/** The entry sits above the module icons, inset like them. */
const buildingEntryContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  padding: "0 8px",
};

/** The hairline that separates the building entry from the modules. */
const railDividerStyle: CSSProperties = {
  width: 28,
  height: 1,
  background: "rgba(27,31,36,0.12)",
  margin: "6px auto",
  flexShrink: 0,
};

/** The building glyph + teal dot + the 8px uppercase caption. */
const buildingEntryStyle: CSSProperties = {
  width: "100%",
  height: 48,
  minHeight: "var(--ff-touch-target)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 1,
  position: "relative",
  background: "transparent",
  border: "none",
  borderRadius: 6,
  color: "var(--ff-text-secondary)",
  cursor: "pointer",
  margin: "2px 0",
  transition: "background 120ms ease, color 120ms ease",
};

const buildingIconWrapStyle: CSSProperties = {
  position: "relative",
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
};

/** The teal "a building is active" dot. */
const buildingDotStyle: CSSProperties = {
  position: "absolute",
  top: -2,
  right: -3,
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: "#0e9488",
  border: "2px solid #fff",
  pointerEvents: "none",
};

/** The 8px uppercase short-name caption. */
const buildingCaptionStyle: CSSProperties = {
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--ff-text-muted)",
  maxWidth: "100%",
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  lineHeight: "10px",
};

/** Desktop dropdown: opens to the RIGHT of the 64px rail. */
const desktopSwitcherStyle: CSSProperties = {
  position: "fixed",
  left: 74,
  top: 58,
  zIndex: 130,
};

/** Phone dropdown: a sheet above the bottom tab bar. */
const mobileSwitcherStyle: CSSProperties = {
  position: "fixed",
  left: 14,
  right: 14,
  bottom: 70,
  width: "auto",
  maxHeight: "46dvh",
  zIndex: 130,
};

// ── Wave 39 — the combined project + building dropdown ─────────────

/** The box recipe; position/height come from the caller's `style`. */
const combinedPanelStyle: CSSProperties = {
  width: 230,
  maxHeight: 420,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 6,
  overflowY: "auto",
  overflowX: "hidden",
};

/** Upper-case frosted section header ("Project" / "Building"). */
const sectionHeaderRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.11em",
  textTransform: "uppercase",
  color: "var(--ff-text-muted)",
  padding: "8px 9px 4px",
};

const projectRowStyle = (current: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 10px",
  borderRadius: 4,
  border: "none",
  background: current ? "var(--ff-bg-hover)" : "transparent",
  color: current ? "var(--ff-blue-active)" : "var(--ff-text-primary)",
  fontSize: 13,
  fontWeight: current ? 600 : 400,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
});

const projectRowLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const checkMarkStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--ff-blue-active)",
  fontWeight: 700,
  fontSize: 13,
};

const leaveRowStyle: CSSProperties = {
  marginTop: 4,
  padding: "9px 10px",
  width: "100%",
  border: "none",
  borderTop: "1px solid var(--ff-border)",
  background: "transparent",
  color: "#d64545",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
};

/** The hairline divider between the PROJECT and BUILDING sections. */
const hairlineStyle: CSSProperties = {
  height: 1,
  margin: "6px 4px",
  background: "rgba(27, 31, 36, 0.1)",
  flexShrink: 0,
};
