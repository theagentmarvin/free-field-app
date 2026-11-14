// src/components/SectionGroupHeader.tsx
//
// Collapsible header for the PDF placeholder block's Unmapped / Mapped
// section groups. Renders the label, a count badge, and a chevron that
// rotates 180° on open per docs/STYLING.md §9.
//
// The chevron rotation uses a CSS transition (150ms ease) — see
// tokens.css for the matching --ff-section-header-transition.

import { CSSProperties, ReactNode } from "react";
import Badge from "./Badge";

export interface SectionGroupHeaderProps {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  className?: string;
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "var(--ff-section-header-py) var(--ff-section-header-px)",
  fontWeight: 600,
  fontSize: "var(--ff-font-size-base)",
  color: "var(--ff-text-primary)",
  textAlign: "left",
  background: "transparent",
  // Non-shorthand borders. The `border: "none"` + `borderBottom: "1px solid ..."`
  // mix is a latent footgun: the wrapperStyle is currently a module
  // const, so React doesn't see a property-set change between renders
  // and the warning doesn't fire. But the moment anyone converts this
  // to a function (e.g. `wrapperStyle(open)`) or inlines it in JSX,
  // React 19's style diff will warn about the shorthand/longhand
  // conflict. Normalise the pattern to all-longhand now.
  borderTop: 0,
  borderRight: 0,
  borderBottom: "1px solid var(--ff-divider)",
  borderLeft: 0,
  cursor: "pointer",
  transition: "background var(--ff-section-header-transition)",
};

const labelStyle: CSSProperties = {
  flex: 1,
};

const chevronStyle = (open: boolean): CSSProperties => ({
  width: 14,
  height: 14,
  transform: open ? "rotate(180deg)" : "rotate(0deg)",
  transition: "transform var(--ff-section-header-transition)",
  color: "var(--ff-text-muted)",
  flexShrink: 0,
});

function ChevronGlyph() {
  // Inline SVG to keep the file zero-dep on an icon library. Matches
  // the lucide-react "chevron-down" shape.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={14}
      height={14}
      aria-hidden
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function SectionGroupHeader({
  label,
  count,
  open,
  onToggle,
  className,
}: SectionGroupHeaderProps): ReactNode {
  return (
    <button
      type="button"
      className={className ?? "ff-section-header"}
      style={wrapperStyle}
      onClick={onToggle}
      aria-expanded={open}
    >
      <span style={labelStyle}>{label}</span>
      <Badge count={count} />
      <span style={chevronStyle(open)} aria-hidden>
        <ChevronGlyph />
      </span>
    </button>
  );
}

export default SectionGroupHeader;
