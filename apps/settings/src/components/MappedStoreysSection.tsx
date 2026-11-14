// src/components/MappedStoreysSection.tsx
//
// Sidebar block that renders the building's "Mapped" set — the
// storeys the user has selected via <LevelChecklistPopover>. The
// section is always open (no collapse) and shows each row's name
// + elevation. Clicking a row opens the corresponding
// OBC.Views plan view in the 3D viewer; clicking the active row
// again closes it. The active row is visually highlighted.
//
// Visual weight matches <SectionGroupHeader> manually (no
// collapsible chevron, no button chrome) per the spec.

import { CSSProperties } from "react";

import { useExtractedStoreys } from "@hooks/useExtractedStoreys";
import { useViewerStore } from "@store/useViewerStore";
import { useViewerHandle } from "@ff/viewer-react";

import Badge from "./Badge";

export interface MappedStoreysSectionProps {
  buildingId: string | null;
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  background: "var(--ff-bg-app)",
};

const headerStyle: CSSProperties = {
  // Match SectionGroupHeader's visual weight but as a non-button
  // <div> — we are NOT collapsible.
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "var(--ff-section-header-py) var(--ff-section-header-px)",
  fontWeight: 600,
  fontSize: "var(--ff-font-size-base)",
  color: "var(--ff-text-primary)",
  borderBottom: "1px solid var(--ff-divider)",
};

const headerLabelStyle: CSSProperties = {
  flex: 1,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  // Non-shorthand padding — `activeRowStyle` overrides `paddingLeft`
  // to 13 to keep the text aligned with the 3px active border, and
  // mixing the `padding` shorthand with the longhand override makes
  // React diff warn on toggle (same pattern as the border shorthand
  // issue below).
  paddingTop: 6,
  paddingRight: 16,
  paddingBottom: 6,
  paddingLeft: 16,
  fontSize: 14,
  // Reset native button chrome — we're a clickable <button> but we
  // want it to look like the surrounding row layout.
  background: "transparent",
  // Non-shorthand border — `activeRowStyle` overrides each side via
  // `borderTop/Right/Bottom/Left`. The 1d61800 fix added the longhand
  // overrides but left the `border: "none"` shorthand in the base,
  // which got spread into the active variant and caused React to warn
  // "Removing a style property during rerender (borderTop) when a
  // conflicting property is set (border)" on every active toggle.
  // The fix is at the BASE, not the override: replace the shorthand
  // with four longhand zeros so the diff is property-by-property.
  borderTop: 0,
  borderRight: 0,
  borderBottom: 0,
  borderLeft: 0,
  width: "100%",
  textAlign: "left",
  cursor: "pointer",
  fontFamily: "inherit",
  color: "inherit",
};

// Active-row style: blue accent matching <GetLevelsButton>'s
// active treatment so the "this is the open view" cue is
// consistent across the app. We add a left border indicator and
// a subtle blue tint.
//
// Note: don't mix shorthand (`border: "none"`, `padding: "6px 16px"`)
// and non-shorthand (`borderLeft: "3px solid ..."`, `paddingLeft: 13`)
// on the same value — React will warn "Removing a style property
// during rerender ... can lead to styling bugs" when the user toggles
// between active and inactive rows. Use only non-shorthand properties
// for both border and padding so the diff is property-by-property
// with no shorthand collision. The original border-shorthand fix
// (commit 1d61800) caught the border axis; this commit completes the
// job by switching padding to non-shorthand too.
const activeRowStyle: CSSProperties = {
  ...rowStyle,
  background: "rgba(37, 99, 235, 0.08)",
  // Non-shorthand border properties only — React compares these
  // to the rowStyle's `border: "none"` and diffs them property by
  // property without the shorthand collision warning.
  borderTop: "3px solid transparent",
  borderRight: "3px solid transparent",
  borderBottom: "3px solid transparent",
  borderLeft: "3px solid var(--ff-blue-active)",
  paddingLeft: 13, // 16 - 3 to keep text alignment
};

// Small "active" pill rendered on the active row so the state is
// also visible without a left-border color shift (e.g. for
// screenshots, color-blind users).
const activeBadgeStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ff-blue-active)",
  background: "rgba(37, 99, 235, 0.16)",
  borderRadius: 3,
  padding: "1px 6px",
  flexShrink: 0,
};

const rowNameStyle: CSSProperties = {
  flex: 1,
  color: "var(--ff-text-primary)",
};

const rowElevationStyle: CSSProperties = {
  color: "var(--ff-text-muted)",
  fontSize: 12,
};

const emptyStyle: CSSProperties = {
  padding: 16,
  color: "var(--ff-text-muted)",
  fontSize: 13,
  lineHeight: 1.5,
};

export default function MappedStoreysSection({
  buildingId,
}: MappedStoreysSectionProps) {
  // Call the hook unconditionally so React's hook order stays
  // stable across renders. The hook itself returns [] for a
  // null buildingId, but we still skip rendering the wrapper
  // markup in that case to match the rest of the sidebar (no
  // active building → no sections).
  const mapped = useExtractedStoreys(buildingId);

  // Viewer integration: read the imperative handle from context
  // (AppShell provides it) and the active view id from the
  // store. The handle's openLevel/closeLevel methods call into
  // OBC.Views on the IfcViewer instance.
  const viewerRef = useViewerHandle();
  const activeStoreyName = useViewerStore((s) => s.activeStoreyName);

  if (buildingId === null) return null;

  return (
    <div
      data-testid="mapped-section"
      data-mapped-count={mapped.length}
      style={wrapperStyle}
      aria-label="Mapped levels"
    >
      <div style={headerStyle}>
        <span style={headerLabelStyle}>Mapped</span>
        <Badge count={mapped.length} />
      </div>
      {mapped.length === 0 ? (
        <div
          data-testid="mapped-section-empty"
          style={emptyStyle}
        >
          {`No levels mapped yet. Click 'Get Levels' to extract.`}
        </div>
      ) : (
        mapped.map(({ extractedId, storey }) => {
          const isActive = activeStoreyName === storey.name;
          return (
            <button
              key={extractedId}
              type="button"
              data-testid="mapped-section-row"
              data-active={isActive ? "true" : undefined}
              onClick={() => {
                if (isActive) {
                  viewerRef.current?.closeLevel();
                  return;
                }
                const opened =
                  viewerRef.current?.openLevel(storey.name) ?? false;
                // If the view didn't open (stale level, model not
                // loaded, etc.), do nothing. The user can refresh
                // by uploading the IFC again. A future improvement:
                // surface a toast.
                if (!opened) {
                  // eslint-disable-next-line no-console
                  console.warn(
                    `[MappedStoreysSection] openLevel('${storey.name}') returned false — view not found`,
                  );
                }
              }}
              style={isActive ? activeRowStyle : rowStyle}
              aria-pressed={isActive}
              aria-label={`Open plan view of ${storey.name}`}
            >
              <span style={rowNameStyle}>{storey.name}</span>
              <span style={rowElevationStyle}>
                z={storey.elevation.toFixed(2)}
              </span>
              {isActive && (
                <span style={activeBadgeStyle}>active</span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
