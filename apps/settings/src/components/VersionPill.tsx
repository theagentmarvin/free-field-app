// src/components/VersionPill.tsx
//
// Small rounded pill showing the current version number of an IFC
// (e.g. "v2"). Styled per docs/STYLING.md §1 / "Acceptance criteria
// > Visual": gray bg, 11px 600 weight.

import { CSSProperties, memo } from "react";

export interface VersionPillProps {
  version: number;
  className?: string;
}

const style: CSSProperties = {
  display: "inline-block",
  padding: "1px 7px",
  borderRadius: 12,
  background: "var(--ff-badge-bg)",
  color: "var(--ff-text-primary)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.03,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
};

function VersionPill({ version, className }: VersionPillProps) {
  return (
    <span
      className={className ?? "ff-version-pill"}
      style={style}
      aria-label={`Version ${version}`}
    >
      v{version}
    </span>
  );
}

export default memo(VersionPill);
