import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";

export interface LeftRailIconProps {
  /** Iconoir (or other) icon component. */
  icon: ReactNode;
  /** Tooltip / aria-label. */
  label: string;
  /** Whether the icon represents the current active surface. */
  active?: boolean;
  /**
   * Internal route path (preferred). When set, renders a react-router
   * <Link> that preserves SPA navigation. Mutually exclusive with `href`.
   */
  to?: string;
  /**
   * External URL (anchor). Use only for cross-app / cross-origin links.
   * When set, renders an <a>. Mutually exclusive with `to`.
   */
  href?: string;
  /** Click handler. Ignored when `to` or `href` is set. */
  onClick?: () => void;
}

/**
 * Single icon button in the LeftRail. 48px square tap target (touch-friendly
 * per --ff-touch-target, with extra breathing room).
 * Active state uses --ff-blue-active.
 *
 * Render shape:
 *  - `to` set  → react-router <Link> (SPA navigation)
 *  - `href` set → plain <a> (external / full-page navigation)
 *  - else → <button>
 *
 * Both link variants get `aria-current="page"` when `active` so screen
 * readers and CSS can target the active surface.
 */
export default function LeftRailIcon(
  props: LeftRailIconProps,
): JSX.Element {
  const { icon, label, active = false, to, href, onClick } = props;

  const wrapperStyle: CSSProperties = {
    width: "100%",
    height: 48,
    minHeight: "var(--ff-touch-target)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: active ? "var(--ff-blue-active)" : "var(--ff-text-secondary)",
    background: active ? "rgba(37, 99, 235, 0.08)" : "transparent",
    border: "none",
    cursor: "pointer",
    borderRadius: 6,
    // No horizontal margin. With `box-sizing: border-box` set
    // globally in styles/global.css, a horizontal margin on an
    // element with `width: 100%` would push the total width past
    // the 64px rail and the right edge would get clipped by the
    // shell's `overflow: hidden`, shifting the visible box to the
    // right and making the icon look off-center. Horizontal
    // spacing lives on the parent <div> in LeftRail.tsx as
    // `padding: 0 8px` instead.
    margin: "2px 0",
    textDecoration: "none",
    transition: "background 120ms ease, color 120ms ease",
  };

  const content = (
    <>
      <span
        style={{
          width: 20,
          height: 20,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {icon}
      </span>
      <span style={{ position: "absolute", left: -9999 }}>{label}</span>
    </>
  );

  const testId = `left-rail-icon-${label.toLowerCase().replace(/\s+/g, "-")}`;

  if (to) {
    return (
      <Link
        to={to}
        style={wrapperStyle}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-testid={testId}
      >
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a
        href={href}
        style={wrapperStyle}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-testid={testId}
      >
        {content}
      </a>
    );
  }

  return (
    <button
      type="button"
      style={wrapperStyle}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
    >
      {content}
    </button>
  );
}
