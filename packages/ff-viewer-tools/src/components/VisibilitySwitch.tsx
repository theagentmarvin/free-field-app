// packages/ff-viewer-tools/src/components/VisibilitySwitch.tsx
//
// Wave 35 (toolbar-nav redesign) — the iOS-style visibility toggle.
//
// The tree rows (Models / Levels / custom filters) used to carry a
// tiny eye glyph button. The redesign swaps it for a 36×21 pill
// switch: the ON state is the blue accent, the OFF state a muted
// track, and the knob slides 15px. Same semantics, calmer reading.
//
// The switch is a real <input type="checkbox"> under the hood, so
// keyboard users get it for free (Space toggles, Tab focuses) and
// the `checked` state is announced by screen readers. The visible
// track is the sibling <span>, which is what the CSS animates.
//
// Sizing is fixed (36×21) per the spec — the row layout reserves
// the space up front so the tree doesn't reflow when a switch turns
// on or off.

import type { CSSProperties } from "react";

export interface VisibilitySwitchProps {
  /** Current state: true = visible. */
  checked: boolean;
  /** Fired with the NEXT state when the user flips the switch. */
  onChange: (next: boolean) => void;
  /** Accessible name (e.g. "Hide sample.ifc"). */
  label: string;
  /** Test hook — defaults to `ff-visibility-switch`. */
  testId?: string;
}

const TRACK_STYLE: CSSProperties = {
  position: "relative",
  display: "inline-block",
  width: 36,
  height: 21,
  flexShrink: 0,
  verticalAlign: "middle",
};

const INPUT_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  margin: 0,
  opacity: 0,
  cursor: "pointer",
};

export default function VisibilitySwitch({
  checked,
  onChange,
  label,
  testId = "ff-visibility-switch",
}: VisibilitySwitchProps): JSX.Element {
  return (
    <span style={TRACK_STYLE} className="ff-visibility-switch">
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        title={label}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
        style={INPUT_STYLE}
      />
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 999,
          background: checked ? "var(--ff-blue-active)" : "rgba(27,31,36,0.18)",
          transition: "background 150ms ease",
          pointerEvents: "none",
        }}
      />
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 2,
          left: 2,
          width: 17,
          height: 17,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
          transform: checked ? "translateX(15px)" : "translateX(0)",
          transition: "transform 150ms ease",
          pointerEvents: "none",
        }}
      />
    </span>
  );
}
