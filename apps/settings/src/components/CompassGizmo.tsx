// src/components/CompassGizmo.tsx
//
// Decorative compass gizmo pinned to the bottom-left of the viewer
// panel. Renders a small SVG with the four cardinal letters (N / S
// / E / W). Per docs/TASK-3-UI.md "Compass gizmo (Task 3)", this
// is *not* wired to the camera rotation — a real camera-aware
// gizmo is future work.
//
// Style: 48px, gray tones, with N slightly more prominent than the
// other cardinals. Bottom-left placement, 8px inset from the edges.

import { ReactNode } from "react";

const wrapperStyle: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  width: "var(--ff-compass-size)",
  height: "var(--ff-compass-size)",
  pointerEvents: "none",
  zIndex: 5,
};

export default function CompassGizmo(): ReactNode {
  return (
    <div style={wrapperStyle} aria-hidden data-testid="compass-gizmo">
      <svg viewBox="-24 -24 48 48" width="48" height="48">
        <circle
          r="22"
          fill="rgba(255, 255, 255, 0.85)"
          stroke="rgba(0, 0, 0, 0.15)"
        />
        <text
          y="-12"
          textAnchor="middle"
          fontSize="10"
          fontWeight={600}
          fill="#374151"
        >
          N
        </text>
        <text
          y="18"
          textAnchor="middle"
          fontSize="10"
          fontWeight={600}
          fill="#9ca3af"
        >
          S
        </text>
        <text
          x="-14"
          y="3"
          textAnchor="middle"
          fontSize="10"
          fontWeight={600}
          fill="#9ca3af"
        >
          W
        </text>
        <text
          x="14"
          y="3"
          textAnchor="middle"
          fontSize="10"
          fontWeight={600}
          fill="#9ca3af"
        >
          E
        </text>
      </svg>
    </div>
  );
}
