// packages/ff-viewer-tools/src/components/FrostedNav.tsx
//
// Wave 39 — the generic frosted navigation shell, extracted from
// apps/models' NavToolbar + NavPanel (wave 35) with ZERO visual or
// behavior change.
//
// Two components, both intentionally PRESENTATIONAL and free of any
// viewer/data dependency (no `@ff/viewer-react`, no Dexie, no
// zustand) — the caller computes `mobile` and owns the store:
//
//   <FrostedNavToolbar>  → the floating, icon-only, segmented pill.
//   <FrostedNavSlot>     → the ONE floating panel rectangle whose
//                          body is `children`.
//
// The wave-35 geometry + testids are reproduced exactly so the
// apps/models NavToolbar.test.tsx / NavPanel.test.tsx regression
// tests pass UNCHANGED.

import { useEffect, type CSSProperties, type ReactNode } from "react";

import "../frosted.css";

// The three wave-35 tokens this surface needs. Kept as literals so
// the package does not have to depend on @ff/tasks-react.
const FOCUS_RING = "#2f6fe4";
const TEXT2 = "#5b626b";
const MUTED = "#8a919c";
const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif';

/** One icon-only button in the toolbar. */
export interface FrostedNavButton {
  id: string;
  label: string;
  /** 24×24 icon path (drawn on a 24×24 grid, 1.8 stroke). */
  path: string;
}

export interface FrostedNavToolbarProps {
  buttons: FrostedNavButton[];
  /** The active button's id (null = none active). */
  activeId: string | null;
  /** Toggle callback. The caller owns the open/close/swap rule. */
  onToggle: (id: string) => void;
  /** Phones only — the pill row scrolls horizontally. */
  mobile?: boolean;
  /** Root <nav> aria-label. Default "Navigation". */
  ariaLabel?: string;
  /** Root <nav> data-testid. Default "nav-toolbar". */
  testId?: string;
  /** Per-button testid factory. Default `${id}` prefixed with `testId`. */
  getButtonTestId?: (id: string) => string;
  /** Wave 40 — per-button count badges (e.g. the open-task count on
   *  the Tasks button). Rendered as a small red chip on the button's
   *  top-right corner; hidden when the count is 0 or absent. */
  badges?: Partial<Record<string, number>>;
  /**
   * Distance from the host's top edge (px). Default 14. A host whose
   * own chrome occupies the top band (Documents' PDF tool row) moves
   * the pill below it instead of covering it.
   */
  top?: number;
}

export function FrostedNavToolbar({
  buttons,
  activeId,
  onToggle,
  mobile = false,
  ariaLabel = "Navigation",
  testId = "nav-toolbar",
  getButtonTestId,
  badges,
  top = 14,
}: FrostedNavToolbarProps): JSX.Element {
  const buttonTestId = getButtonTestId
    ? getButtonTestId
    : (id: string): string => `${testId}-${id}`;

  const barStyle: CSSProperties = {
    position: "absolute",
    top,
    left: 14,
    zIndex: 22,
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: 4,
    borderRadius: 14,
    fontFamily: FONT,
    ...(mobile
      ? {
          maxWidth: "calc(100% - 28px)",
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none" as const,
        }
      : null),
  };

  return (
    <nav
      style={barStyle}
      className="ff-frosted ff-nav-toolbar"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {buttons.map((btn) => {
        const active = activeId === btn.id;
        const badgeCount = badges?.[btn.id] ?? 0;
        return (
          <button
            key={btn.id}
            type="button"
            title={btn.label}
            aria-label={btn.label}
            aria-pressed={active}
            data-testid={buttonTestId(btn.id)}
            onClick={() => onToggle(btn.id)}
            style={{ ...buttonStyle(active), position: "relative" }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={btn.path} />
            </svg>
            {badgeCount > 0 && (
              <span
                data-testid={`${buttonTestId(btn.id)}-badge`}
                style={badgeStyle}
              >
                {badgeCount}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/** One toolbar segment (raised white pill when active). */
function buttonStyle(active: boolean): CSSProperties {
  return {
    width: 38,
    height: 34,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 0,
    border: "none",
    borderRadius: 999,
    background: active ? "#ffffff" : "transparent",
    color: active ? FOCUS_RING : TEXT2,
    cursor: "pointer",
    boxShadow: active ? "0 2px 8px rgba(16,24,40,0.12)" : "none",
    transition: "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}

/** Wave 40 — the count chip on a toolbar button (e.g. open tasks). */
const badgeStyle: CSSProperties = {
  position: "absolute",
  top: 2,
  right: 2,
  minWidth: 15,
  height: 15,
  padding: "0 3.5px",
  borderRadius: 999,
  background: "#e5484d",
  color: "#ffffff",
  fontSize: 9.5,
  fontWeight: 700,
  lineHeight: "15px",
  textAlign: "center",
  border: "1.5px solid #ffffff",
  boxSizing: "border-box",
  pointerEvents: "none",
};

export interface FrostedNavSlotProps {
  /** True when a tenant owns the slot. */
  open: boolean;
  /** The header title (caller maps the active tenant → label). */
  title: string;
  /** Close callback (also wired to Escape). */
  onClose: () => void;
  /** Phones only — the slot becomes a bottom sheet. */
  mobile?: boolean;
  children?: ReactNode;
  /** Root <section> aria-label. Default "Navigation panel". */
  ariaLabel?: string;
  /** Root <section> data-testid. Default "nav-panel". */
  testId?: string;
  /** The active tenant id for `data-panel` (caller-owned). */
  dataPanel?: string;
  /**
   * Distance of the desktop panel from the host's top edge (px).
   * Default 66 (= toolbar top 14 + pill 52). Ignored on phones (the
   * slot is a bottom sheet there).
   */
  top?: number;
}

export function FrostedNavSlot({
  open,
  title,
  onClose,
  mobile = false,
  children,
  ariaLabel = "Navigation panel",
  testId = "nav-panel",
  dataPanel,
  top = 66,
}: FrostedNavSlotProps): JSX.Element {
  // Escape closes the slot (and, for Models, clears the selection —
  // the caller's `onClose` does both).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const panelStyle: CSSProperties = mobile
    ? {
        // Phone: bottom sheet (the MobileStack pattern).
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        maxHeight: "46dvh",
        borderRadius: "18px 18px 0 0",
        display: open ? "flex" : "none",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 21,
      }
    : {
        position: "absolute",
        top,
        left: 14,
        width: 320,
        // 54 px bottom margin (66 + 54 = the original 120 px).
        height: `min(500px, calc(100% - ${top + 54}px))`,
        display: open ? "flex" : "none",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 21,
      };

  const headStyle: CSSProperties = {
    height: 44,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 14px",
  };

  const titleStyle: CSSProperties = {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.1em",
    textTransform: "uppercase",
    color: TEXT2,
    fontFamily: FONT,
  };

  const bodyStyle: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: 8,
  };

  const closeButtonStyle: CSSProperties = {
    width: 28,
    height: 28,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: 8,
    background: "transparent",
    color: MUTED,
    fontSize: 14,
    cursor: "pointer",
  };

  return (
    <section
      style={panelStyle}
      className={
        open
          ? "ff-frosted ff-frosted--panel ff-nav-panel ff-nav-panel--open"
          : "ff-frosted ff-frosted--panel ff-nav-panel"
      }
      aria-label={ariaLabel}
      data-testid={testId}
      data-open={open ? "true" : "false"}
      data-panel={dataPanel}
      aria-hidden={open ? undefined : true}
    >
      <div style={headStyle} className="ff-nav-panel__head">
        <span style={titleStyle} data-testid={`${testId}-title`}>
          {title}
        </span>
        <button
          type="button"
          aria-label="Close panel"
          title="Close"
          onClick={onClose}
          style={closeButtonStyle}
          data-testid={`${testId}-close`}
        >
          ✕
        </button>
      </div>
      <div style={bodyStyle} data-testid={`${testId}-body`}>
        {children}
      </div>
    </section>
  );
}