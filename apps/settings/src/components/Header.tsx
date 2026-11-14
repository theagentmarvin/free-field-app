// src/components/Header.tsx
//
// Top bar: FreeField mark + wordmark on the left, <BuildingTabs> in the
// middle. Maintainer removed the decorative window-chrome circles (2026-06-01)
// — the right edge is intentionally empty. STYLING.md §4 updated to
// match.

import BuildingTabs from "./BuildingTabs";
import FreeFieldMark from "../shell/FreeFieldMark";

export interface HeaderProps {
  projectId: string;
  activeBuildingId: string | null;
  onActiveBuildingChange: (id: string | null) => void;
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  height: "var(--ff-header-height)",
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flexShrink: 0,
  padding: "0 12px 0 16px",
  gap: 12,
};

const brandStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ff-text-primary)",
  letterSpacing: 0.01,
  marginRight: 8,
  flexShrink: 0,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

export default function Header({
  projectId,
  activeBuildingId,
  onActiveBuildingChange,
}: HeaderProps) {
  return (
    <header style={headerStyle} role="banner">
      <div style={brandStyle}>
        <FreeFieldMark size={22} />
        <span>FreeField</span>
      </div>
      <BuildingTabs
        projectId={projectId}
        activeBuildingId={activeBuildingId}
        onActiveBuildingChange={onActiveBuildingChange}
      />
    </header>
  );
}
