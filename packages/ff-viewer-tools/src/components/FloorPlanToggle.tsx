// packages/ff-viewer-tools/src/components/FloorPlanToggle.tsx
//
// Task 23: segmented toggle that switches the RIGHT 3D viewer
// between two visual modes:
//
//   "Navigate"  — walk-through mode (spawn-point camera, WASD)
//   "Floor Plan" — the selected mapped PDF rendered as a
//                  semi-transparent textured plane in 3D space
//
// The toggle is disabled when no PDF is selected (the parent
// controls the `disabled` prop).

import { useCallback, type CSSProperties, type ReactNode } from "react";

export type RightViewerMode = "navigate" | "floorPlan";

export interface FloorPlanToggleProps {
  /** Current mode. */
  value: RightViewerMode;
  /** Called when the user clicks the other mode. */
  onChange: (mode: RightViewerMode) => void;
  /** Disabled state — e.g. no mapped PDF selected. */
  disabled?: boolean;
}

export default function FloorPlanToggle({
  value,
  onChange,
  disabled = false,
}: FloorPlanToggleProps): ReactNode {
  const handleNavigate = useCallback(() => {
    if (!disabled) onChange("navigate");
  }, [onChange, disabled]);

  const handleFloorPlan = useCallback(() => {
    if (!disabled) onChange("floorPlan");
  }, [onChange, disabled]);

  return (
    <div
      style={containerStyle}
      role="radiogroup"
      aria-label="Right viewer mode"
      data-testid="floor-plan-toggle"
    >
      <button
        type="button"
        role="radio"
        aria-checked={value === "navigate"}
        aria-label="Walk-through navigation"
        disabled={disabled}
        onClick={handleNavigate}
        style={{
          ...segmentStyle,
          background:
            value === "navigate"
              ? "var(--ff-blue-active, #4a90d9)"
              : "transparent",
          color:
            value === "navigate"
              ? "#fff"
              : "var(--ff-text-muted, #888)",
        }}
        data-testid="floor-plan-toggle-navigate"
      >
        Navigate
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "floorPlan"}
        aria-label="Overlay"
        disabled={disabled}
        onClick={handleFloorPlan}
        style={{
          ...segmentStyle,
          background:
            value === "floorPlan"
              ? "var(--ff-blue-active, #4a90d9)"
              : "transparent",
          color:
            value === "floorPlan"
              ? "#fff"
              : "var(--ff-text-muted, #888)",
        }}
        data-testid="floor-plan-toggle-overlay"
      >
        Overlay
      </button>
    </div>
  );
}

const containerStyle: CSSProperties = {
  display: "flex",
  gap: 0,
  margin: "0 16px",
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid var(--ff-border)",
  opacity: 1,
  transition: "opacity 150ms",
};

const segmentStyle: CSSProperties = {
  flex: 1,
  height: 28,
  padding: 0,
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  outline: "none",
  transition: "background 120ms, color 120ms",
  letterSpacing: "0.02em",
};
