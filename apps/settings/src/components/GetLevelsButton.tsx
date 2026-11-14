// src/components/GetLevelsButton.tsx
//
// Toggles <LevelChecklistPopover>. Renders as a button matching the
// other entries in the IFC block header row. Active state is
// communicated via the `open` prop.

import { ReactNode } from "react";

export interface GetLevelsButtonProps {
  open: boolean;
  onToggle: () => void;
  busy?: boolean;
}

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 30,
  padding: "0 12px",
  fontSize: 14,
  fontWeight: 600,
  fontFamily: "inherit",
  borderRadius: 4,
  cursor: "pointer",
  background: "transparent",
  // Non-shorthand borders. The original `border: "1px solid transparent"`
  // shorthand was spread into both `idleStyle` and `activeStyle`; the
  // active variant then overrode `borderColor` (a longhand) on top of
  // the shorthand, which made React 19's style diff warn
  // "Removing a style property during rerender (borderColor) when a
  // conflicting property is set (border)" on every Get-Levels toggle.
  // Use four longhand borders at the base (transparent for idle, blue
  // for active) so the diff is property-by-property.
  borderTop: "1px solid transparent",
  borderRight: "1px solid transparent",
  borderBottom: "1px solid transparent",
  borderLeft: "1px solid transparent",
  flexShrink: 0,
};

const idleStyle: React.CSSProperties = {
  ...baseStyle,
  color: "var(--ff-text-muted)",
};

const activeStyle: React.CSSProperties = {
  ...baseStyle,
  color: "var(--ff-blue-active)",
  background: "rgba(37, 99, 235, 0.08)",
  // Override the four transparent borders with the active blue.
  // Border color matches the prior alpha-25% with the same effect.
  borderTopColor: "rgba(37, 99, 235, 0.25)",
  borderRightColor: "rgba(37, 99, 235, 0.25)",
  borderBottomColor: "rgba(37, 99, 235, 0.25)",
  borderLeftColor: "rgba(37, 99, 235, 0.25)",
};

export default function GetLevelsButton({
  open,
  onToggle,
  busy = false,
}: GetLevelsButtonProps): ReactNode {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={busy}
      style={open ? activeStyle : idleStyle}
      aria-pressed={open}
      aria-label="Get levels"
      data-testid="get-levels-button"
    >
      Get Levels
    </button>
  );
}
