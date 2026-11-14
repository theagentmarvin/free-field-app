// packages/ff-viewer-tools/src/components/MobileStack.tsx
//
// Task 36 — the shared sidebar↔content layout primitive.
//
// Desktop (≥ 768px): a ROW — [sidebar | main]. Byte-for-byte the
// same box model the modules used before the mobile pass, so the
// desktop rendering is unchanged.
//
// Mobile (< 768px): a COLUMN — the sidebar becomes a TOP SHEET
// above the main pane:
//
//   ┌───────────────────────────┐  ← 100% wide, ≤ 45dvh, scrolls
//   │  sidebar (top sheet)      │
//   ├───────────────────────────┤  ← main pane takes the rest
//   │  main                     │
//   └───────────────────────────┘
//
// The sheet keeps the module's own header row (building picker +
// counts) as its summary — this wrapper does NOT restyle module
// internals, it only changes the container they live in.
//
// The breakpoint comes from `useIsMobile()` (the single source of
// truth — see ../hooks/useIsMobile.ts), NOT from a media query
// here, so the JS layout and the app's CSS rules always agree.

import type { CSSProperties, ReactNode } from "react";

import { useIsMobile } from "../hooks/useIsMobile";

export interface MobileStackProps {
  /** The sidebar pane (module-specific content). */
  sidebar: ReactNode;
  /** The main pane (viewer / canvas / list). */
  main: ReactNode;
  /**
   * Width of the sidebar column on desktop. A CSS length
   * (`"var(--ff-sidebar-width)"`) or a pixel number. Omit when the
   * sidebar child already sizes itself (e.g. a resizable pane).
   */
  sidebarWidth?: number | string;
  /** Extra class on the container (the `ff-mobile-stack` classes are always applied). */
  className?: string;
  /** Max height of the mobile top sheet. Defaults to `45dvh`. */
  maxSheetHeight?: string;
}

/** Desktop row: sidebar + main, side by side. */
const rowContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  flex: 1,
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

const rowSidebarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  minWidth: 0,
  minHeight: 0,
};

const rowMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

/** Mobile column: top sheet + main pane. */
const sheetContainerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  width: "100%",
  height: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

const sheetSidebarStyle = (maxSheetHeight: string): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  width: "100%",
  maxHeight: maxSheetHeight,
  overflowY: "auto",
  overflowX: "hidden",
  minHeight: 0,
});

const sheetMainStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
};

/**
 * Renders [sidebar | main] on desktop and [sidebar-sheet | main]
 * on phones. See the file header for the geometry.
 */
export default function MobileStack({
  sidebar,
  main,
  sidebarWidth,
  className,
  maxSheetHeight = "45dvh",
}: MobileStackProps): ReactNode {
  const isMobile = useIsMobile();

  const classes = [
    "ff-mobile-stack",
    isMobile ? "ff-mobile-stack--sheet" : "ff-mobile-stack--row",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  if (isMobile) {
    return (
      <div
        style={sheetContainerStyle}
        className={classes}
        data-testid="mobile-stack"
      >
        <div
          style={sheetSidebarStyle(maxSheetHeight)}
          className="ff-mobile-stack__sidebar"
          data-testid="mobile-stack-sidebar"
        >
          {sidebar}
        </div>
        <div
          style={sheetMainStyle}
          className="ff-mobile-stack__main"
          data-testid="mobile-stack-main"
        >
          {main}
        </div>
      </div>
    );
  }

  return (
    <div
      style={rowContainerStyle}
      className={classes}
      data-testid="mobile-stack"
    >
      <div
        style={
          sidebarWidth === undefined
            ? rowSidebarStyle
            : { ...rowSidebarStyle, width: sidebarWidth }
        }
        className="ff-mobile-stack__sidebar"
        data-testid="mobile-stack-sidebar"
      >
        {sidebar}
      </div>
      <div
        style={rowMainStyle}
        className="ff-mobile-stack__main"
        data-testid="mobile-stack-main"
      >
        {main}
      </div>
    </div>
  );
}
