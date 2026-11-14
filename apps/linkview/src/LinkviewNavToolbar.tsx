// apps/linkview/src/LinkviewNavToolbar.tsx
//
// Wave 55 — the Link view TOOLS toolbar (canonical name per
// docs/ux/toolbar-nomenclature.md): the floating, icon-only,
// segmented pill anchored at the TOP-LEFT of the 3D viewer pane —
// same geometry and visual language as the Models <NavToolbar>
// (<FrostedNavToolbar>, wave 35/39).
//
// Two button groups in ONE pill:
//
//   [⬡ Models & Levels] [⏷ Filters]  → the Models module's filter
//       tools (2026-11-14): same panels, same shared store, so hiding
//       a model or applying a filter here acts on the right 3D pane
//       exactly as it does in Models.
//   [🗎 Mapped PDFs] [⧉ Model Floor Plans]  → panel toggles. Open the
//       ONE floating panel slot (<LinkviewNavPanel>) below the pill;
//       inactive → open, active → close, other → swap in place (the
//       Models NavToolbar rule).
//   ────────────
//   [▫ Split View] [◫ Overlap]  → layout-mode toggles (aria-pressed).
//       Wave 55: MOVED here from the viewer tools toolbar (the
//       bottom-center band is for direct viewer tools only — Measure,
//       Save view).
//
// Custom component (not <FrostedNavToolbar>) because that shell
// models a single button group with one activeId; this pill needs
// two independent pressed states (open panel + active mode). The
// geometry, class names, and button metrics are copied 1:1 from
// FrostedNavToolbar so the two modules' tools toolbars are
// pixel-identical.

import { type CSSProperties, type ReactNode } from "react";

import type { LinkviewMode } from "./linkviewMode";

import "../../models/src/frosted.css";

const FOCUS_RING = "#2f6fe4";
const TEXT2 = "#5b626b";

export type LinkviewPanelId = "models" | "filters" | "pdfs" | "plans";

export interface LinkviewNavToolbarProps {
  /** Currently open panel tenant (null = closed). */
  activePanel: LinkviewPanelId | null;
  /** Panel button click — the caller owns the open/close/swap rule. */
  onTogglePanel: (id: LinkviewPanelId) => void;
  /** Current layout mode. */
  mode: LinkviewMode;
  /** Mode button click. */
  onModeChange: (mode: LinkviewMode) => void;
  /** Phones only — the pill row scrolls horizontally. */
  mobile?: boolean;
}

/** 24×24 icon paths (1.8 stroke), same family as the Models pill. */
const ICONS = {
  // Models & Levels — same building glyph as the Models / Documents pill.
  models: "M12 2l8 4.5v9L12 20l-8-4.5v-9L12 2zM4 11l8 4.5 8-4.5",
  // Filters — funnel, same glyph as the Models / Documents pill.
  filters: "M3 5h18l-7 8v5l-4 2v-7L3 5z",
  // Mapped PDFs — document with ruled lines.
  pdfs: "M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9l-5-6zM13 3v6h5M9 13h6M9 17h4",
  // Model Floor Plans — stacked storey slabs.
  plans: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  // Split View — two panes side by side.
  split: "M3 5h7v14H3V5zM14 5h7v14h-7V5z",
  // Overlap — one pane over another.
  overlap: "M9 3h12v12M3 9h12v12H3V9z",
} as const;

export default function LinkviewNavToolbar({
  activePanel,
  onTogglePanel,
  mode,
  onModeChange,
  mobile = false,
}: LinkviewNavToolbarProps): ReactNode {
  // FrostedNavToolbar barStyle, copied 1:1 (wave 39 geometry).
  const barStyle: CSSProperties = {
    position: "absolute",
    top: 14,
    left: 14,
    zIndex: 22,
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: 4,
    borderRadius: 14,
    ...(mobile
      ? {
          maxWidth: "calc(100% - 28px)",
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none" as const,
        }
      : null),
  };

  return (
    <nav
      style={barStyle}
      className="ff-frosted ff-nav-toolbar"
      aria-label="Link view tools"
      data-testid="linkview-tools-toolbar"
    >
      <ToolbarButton
        testId="linkview-tools-models"
        label="Models & Levels"
        path={ICONS.models}
        active={activePanel === "models"}
        onClick={() => onTogglePanel("models")}
      />
      <ToolbarButton
        testId="linkview-tools-filters"
        label="Filters"
        path={ICONS.filters}
        active={activePanel === "filters"}
        onClick={() => onTogglePanel("filters")}
      />
      <ToolbarButton
        testId="linkview-tools-pdfs"
        label="Mapped PDFs"
        path={ICONS.pdfs}
        active={activePanel === "pdfs"}
        onClick={() => onTogglePanel("pdfs")}
      />
      <ToolbarButton
        testId="linkview-tools-plans"
        label="Model Floor Plans"
        path={ICONS.plans}
        active={activePanel === "plans"}
        onClick={() => onTogglePanel("plans")}
      />
      <span
        aria-hidden
        style={{
          width: 1,
          height: 24,
          margin: "0 4px",
          background: "rgba(91,98,107,0.35)",
          flexShrink: 0,
        }}
      />
      <ToolbarButton
        testId="linkview-tools-split"
        label="Split View"
        path={ICONS.split}
        active={mode === "split"}
        onClick={() => onModeChange("split")}
      />
      <ToolbarButton
        testId="linkview-tools-overlap"
        label="Overlap"
        path={ICONS.overlap}
        active={mode === "overlap"}
        onClick={() => onModeChange("overlap")}
      />
    </nav>
  );
}

function ToolbarButton({
  testId,
  label,
  path,
  active,
  onClick,
}: {
  testId: string;
  label: string;
  path: string;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onClick={onClick}
      style={buttonStyle(active)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={path} />
      </svg>
    </button>
  );
}

/** One toolbar segment (raised white pill when active) — copied 1:1
 *  from FrostedNavToolbar's buttonStyle. */
function buttonStyle(active: boolean): CSSProperties {
  return {
    width: 38,
    height: 34,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    padding: 0,
    border: "none",
    borderRadius: 999,
    background: active ? "#ffffff" : "transparent",
    color: active ? FOCUS_RING : TEXT2,
    cursor: "pointer",
    boxShadow: active ? "0 2px 8px rgba(16,24,40,0.12)" : "none",
    transition: "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}
