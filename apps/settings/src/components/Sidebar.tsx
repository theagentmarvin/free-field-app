// src/components/Sidebar.tsx
//
// Left-side panel that stacks the PDF placeholder block (top, ~50%)
// and the IFC block (bottom, ~50%). Width is fixed per
// docs/STYLING.md §3. The two blocks split the available height
// evenly; either can scroll internally.

import { ReactNode } from "react";

import IfcSidebarBlock from "./IfcSidebarBlock";
import PdfSidebarBlock from "./PdfSidebarBlock";

export interface SidebarProps {
  buildingId: string | null;
}

const wrapperStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  width: "var(--ff-sidebar-width)",
  flexShrink: 0,
  height: "100%",
  background: "var(--ff-bg-app)",
  borderRight: "1px solid var(--ff-border)",
  overflow: "hidden",
};

const splitStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

const halfStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

export default function Sidebar({ buildingId }: SidebarProps): ReactNode {
  return (
    <aside style={wrapperStyle} aria-label="Sidebar">
      <div style={splitStyle}>
        <div style={halfStyle}>
          <PdfSidebarBlock buildingId={buildingId} />
        </div>
        <div style={halfStyle}>
          <IfcSidebarBlock buildingId={buildingId} />
        </div>
      </div>
    </aside>
  );
}
