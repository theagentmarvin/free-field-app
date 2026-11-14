// apps/settings/src/shell/ProjectAccess.tsx
//
// Wave 9 (spec §B) project access — the once-at-entry picker, the compact
// in-view icon button, and the bottom-sheet switcher with "Leave project".
// Project identity lives HERE (one surface), replacing the per-view
// dropdown card. Pure presentational over `projectChoice.ts` — the shell
// owns the choice state and hands each surface its props.

import { useCallback, useEffect, useRef, useState } from "react";

import { tokens } from "@ff/tasks-react";

import { type ProjectOption } from "./projectChoice";

const c = tokens.color;
const r = tokens.radius;
const f = tokens.fontSize;

const AVATAR_PALETTE = ["#2f6fe4", "#0e9488", "#e8791f", "#e8a124", "#7a828c"];
function swatchColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// ── shared bits ─────────────────────────────────────────────────────────

function BuildingIcon({ size = 20 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={{ display: "block" }}
    >
      <path
        d="M4 21V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v16M12 21V9a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v12M2 21h20M7 8h2M7 12h2M7 16h2M15 12h2M15 16h2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Swatch({ id, initials, size = 38 }: { id: string; initials: string; size?: number }): JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: size >= 38 ? 10 : 9,
        display: "grid",
        placeItems: "center",
        color: "#fff",
        fontWeight: 700,
        fontSize: size >= 38 ? 14 : 13,
        letterSpacing: "0.02em",
        flex: "0 0 auto",
        background: swatchColor(id),
      }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

// ── entry screen ────────────────────────────────────────────────────────

export interface ProjectEntryScreenProps {
  projects: readonly ProjectOption[];
  currentId: string | null;
  onChoose: (id: string) => void;
  /**
   * Wave 63: false when nobody is signed in — the empty state then
   * offers a sign-in link. Defaults to true (signed in, or demo).
   */
  signedIn?: boolean;
}

export function ProjectEntryScreen({
  projects,
  currentId,
  onChoose,
  signedIn = true,
}: ProjectEntryScreenProps): JSX.Element {
  return (
    <div
      data-testid="project-entry-screen"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: c.bg,
        overflow: "auto",
      }}
    >
      <div style={{ padding: "40px 20px 16px", background: c.primary, color: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: f.base, fontWeight: 700, opacity: 0.85, marginBottom: 10 }}>
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              background: c.focusRing,
              display: "grid",
              placeItems: "center",
              fontSize: 13,
            }}
            aria-hidden
          >
            F
          </span>
          FreeField
        </div>
        <h2 style={{ fontSize: f.xl, margin: 0, fontWeight: 700 }}>Choose a project</h2>
        <div style={{ fontSize: f.md, color: "rgba(255,255,255,0.72)", marginTop: 4 }}>
          Pick once — we&rsquo;ll remember it next time.
        </div>
      </div>
      <div style={{ padding: "16px 16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: f.xs, letterSpacing: "0.09em", textTransform: "uppercase", fontWeight: 700, color: c.muted }}>
          Your projects
        </span>
        {projects.length === 0 ? (
          <div
            data-testid="project-entry-empty"
            style={{
              padding: "16px 12px",
              border: `1px dashed ${c.border}`,
              borderRadius: r.md,
              background: c.surface,
              color: c.text,
              fontSize: f.md,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {signedIn ? (
              <>
                <span>You don&rsquo;t have access to a project yet.</span>
                <span style={{ color: c.muted, fontSize: f.sm }}>
                  Ask a project admin for an invitation, or{" "}
                  <a href="/sign-in" data-testid="project-entry-sign-in" style={{ color: c.focusRing }}>
                    sign in with another account
                  </a>
                  .
                </span>
              </>
            ) : (
              <>
                <span>Sign in to see your projects.</span>
                <a
                  href="/sign-in"
                  data-testid="project-entry-sign-in"
                  style={{ color: c.focusRing, fontWeight: 700 }}
                >
                  Sign in
                </a>
              </>
            )}
          </div>
        ) : null}
        {projects.map((p) => {
          const current = p.id === currentId;
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`project-entry-option-${p.id}`}
              aria-pressed={current}
              onClick={() => onChoose(p.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "13px 12px",
                border: current ? `1px solid ${c.focusRingLine}` : `1px solid ${c.border}`,
                borderRadius: r.md,
                background: current ? c.focusRingTint : c.surface,
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
                fontFamily: "inherit",
                textAlign: "left",
              }}
            >
              <Swatch id={p.id} initials={p.initials} />
              <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: f.base, color: c.text, display: "block" }}>{p.name}</span>
                {p.meta ? (
                  <span style={{ fontSize: f.sm, color: c.muted }}>{p.meta}</span>
                ) : null}
              </span>
              <span style={{ color: c.focusRing, fontWeight: 700, fontSize: f.base }} aria-hidden>
                {current ? "✓" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── in-view icon button + switcher sheet ────────────────────────────────

export interface ProjectAccessButtonProps {
  projects: readonly ProjectOption[];
  currentId: string | null;
  onSwitch: (id: string) => void;
  onLeave: () => void;
}

/**
 * @deprecated wave 39 — the top-right project-access icon was removed
 * from <MainShell>; project switching now lives in the rail-start
 * combined project+building switcher (LeftRail). Kept exported only
 * because the shell tests import it.
 */
export function ProjectAccessButton({ projects, currentId, onSwitch, onLeave }: ProjectAccessButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        type="button"
        data-testid="project-access-button"
        aria-label="Switch project"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          position: "absolute",
          top: 8,
          right: 12,
          zIndex: 40,
          width: 44,
          height: 44,
          display: "grid",
          placeItems: "center",
          border: `1px solid ${c.borderStrong}`,
          borderRadius: 10,
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
          cursor: "pointer",
          color: c.text2,
        }}
      >
        <BuildingIcon />
      </button>

      {open && (
        <>
          <div
            data-testid="project-switcher-scrim"
            aria-hidden
            onClick={close}
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(16,20,26,0.42)",
              zIndex: 41,
            }}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-label="Switch project"
            data-testid="project-switcher-sheet"
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 42,
              background: c.surface,
              borderRadius: "16px 16px 0 0",
              boxShadow: "0 -10px 30px rgba(16,24,40,0.22)",
              padding: "6px 16px 18px",
              display: "flex",
              flexDirection: "column",
              gap: 2,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0 8px" }}>
              <span style={{ flex: "1 1 auto", fontWeight: 700, fontSize: f.base, color: c.text }}>Switch project</span>
              <button
                type="button"
                aria-label="Close switcher"
                onClick={close}
                style={{ width: 34, height: 34, display: "grid", placeItems: "center", border: "none", background: c.surface2, borderRadius: 10, cursor: "pointer", fontSize: 15, color: c.text2 }}
              >
                ✕
              </button>
            </div>
            {projects.map((p) => {
              const current = p.id === currentId;
              return (
                <button
                  key={p.id}
                  type="button"
                  data-testid={`project-switcher-option-${p.id}`}
                  aria-pressed={current}
                  onClick={() => {
                    onSwitch(p.id);
                    close();
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 6px",
                    borderRadius: 10,
                    cursor: "pointer",
                    background: current ? c.focusRingTint : "transparent",
                    boxShadow: current ? `inset 2px 0 0 ${c.focusRing}` : "none",
                    border: "none",
                    fontFamily: "inherit",
                    textAlign: "left",
                  }}
                >
                  <Swatch id={p.id} initials={p.initials} size={32} />
                  <span style={{ flex: "1 1 auto", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: f.md, color: c.text, display: "block" }}>{p.name}</span>
                    {p.meta ? <span style={{ fontSize: f.xs, color: c.muted }}>{p.meta}</span> : null}
                  </span>
                  {current ? <span style={{ color: c.focusRing, fontWeight: 700 }} aria-hidden>✓</span> : null}
                </button>
              );
            })}
            <button
              type="button"
              data-testid="project-switcher-leave"
              onClick={() => {
                onLeave();
                close();
              }}
              style={{
                marginTop: 6,
                padding: "13px",
                textAlign: "center",
                color: c.danger,
                fontWeight: 700,
                fontSize: f.base,
                cursor: "pointer",
                border: "none",
                borderTop: `1px solid ${c.border}`,
                background: "transparent",
                fontFamily: "inherit",
              }}
            >
              Leave project
            </button>
          </div>
        </>
      )}
    </>
  );
}

/** Light wrapper so the switcher can be used elsewhere without the icon.
 *
 * @deprecated wave 39 — superseded by the rail-start combined switcher. */
export function ProjectSwitcherSheet(props: ProjectAccessButtonProps): JSX.Element {
  return <ProjectAccessButton {...props} />;
}