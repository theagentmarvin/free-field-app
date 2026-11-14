import type { CSSProperties } from "react";

import { statusColor } from "./logic";

/**
 * Tasks sheet design tokens + shared style objects (docs/ux/
 * design-tokens-v2.md is the spec of record — the boss validated it).
 *
 * The package keeps its inline-style pattern, so this module exports
 * PLAIN OBJECTS (no CSS-in-JS runtime): a `tokens` record, a
 * status→{bg,ink} accent resolver, and a set of reusable
 * `CSSProperties` fragments the compose/detail/popup sheets compose.
 */

export const tokens = {
  color: {
    canvas: "#e8ebee",
    bg: "#f6f7f9",
    surface: "#ffffff",
    surface2: "#fafbfc",
    border: "#e7e9ec",
    borderStrong: "#d6dbe1",
    text: "#1b1f24",
    text2: "#5b626b",
    muted: "#8a919c",
    primary: "#181c22",
    primaryHover: "#272d35",
    onPrimary: "#ffffff",
    focusRing: "#2f6fe4",
    danger: "#d64545",
    focusRingTint: "rgba(47,111,228,0.08)",
    focusRingLine: "rgba(47,111,228,0.22)",
    focusRingInk: "#2a5bb8",
    offlineBg: "#fbf0dd",
    offlineInk: "#8a5a00",
    scrim: "rgba(16,20,26,0.42)",
  },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  space: { s1: 4, s2: 8, s3: 12, s4: 16, s5: 20, s6: 24, s8: 32 },
  fontSize: { xs: 11, sm: 12, md: 13, base: 14, lg: 16, xl: 18 },
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif',
  shadow: {
    card: "0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)",
    raised: "0 6px 20px rgba(16,24,40,0.10)",
    sticky: "0 -6px 16px rgba(16,24,40,0.08)",
    popup: "0 -10px 30px rgba(16,24,40,0.22)",
  },
} as const;

/**
 * Status band accent — source of truth is the existing
 * `STATUS_COLORS`→`statusColor()` mapping; this only adds the hex +
 * contrast ink the v2 tokens need (amber/yellow → dark ink, the rest
 * white). 1:1 with the swatches in design-tokens-v2.md.
 */
const STATUS_HEX: Record<string, { bg: string; ink: string }> = {
  blue: { bg: "#2f6fe4", ink: "#ffffff" },
  yellow: { bg: "#e8a124", ink: "#2b1a00" },
  red: { bg: "#d64545", ink: "#ffffff" },
  orange: { bg: "#e8791f", ink: "#ffffff" },
  teal: { bg: "#0e9488", ink: "#ffffff" },
  green: { bg: "#22a558", ink: "#ffffff" },
  gray: { bg: "#7a828c", ink: "#ffffff" },
};

export function statusAccent(status: number): { bg: string; ink: string } {
  return STATUS_HEX[statusColor(status)] ?? STATUS_HEX.gray;
}

// ── shared fragments ──────────────────────────────────────────────────────

const { color: c, radius: r, space: s, fontSize: f, font, shadow } = tokens;

export const sectionLabelStyle: CSSProperties = {
  fontSize: f.xs,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: c.muted,
  margin: "0 0 8px",
};

export const cardStyle: CSSProperties = {
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: r.lg,
  boxShadow: shadow.card,
  padding: s.s4,
};

export const cardTightStyle: CSSProperties = {
  ...cardStyle,
  padding: `${s.s3}px ${s.s4}px`,
};

export const topBarStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: s.s2,
  minHeight: 52,
  padding: `0 ${s.s4}px`,
  background: c.surface,
  borderBottom: `1px solid ${c.border}`,
};

export const iconButtonStyle: CSSProperties = {
  width: 40,
  height: 40,
  flex: "0 0 auto",
  display: "grid",
  placeItems: "center",
  border: "none",
  background: c.surface2,
  borderRadius: r.md,
  cursor: "pointer",
  fontSize: 16,
  color: c.text2,
  position: "relative",
  padding: 0,
};

export const iconButtonSmallStyle: CSSProperties = {
  ...iconButtonStyle,
  width: 34,
  height: 34,
};

export const offlineStripStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: `6px ${s.s4}px`,
  background: c.offlineBg,
  borderBottom: `1px solid ${c.border}`,
  color: c.offlineInk,
  fontSize: f.xs,
  fontWeight: 600,
};

/** pill chip (neutral default) */
export const chipStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: c.surface2,
  border: `1px solid ${c.border}`,
  borderRadius: r.pill,
  padding: "2px 10px",
  fontSize: f.sm,
  fontWeight: 600,
  color: c.text2,
  whiteSpace: "nowrap",
};

/** selectable option chip (type / quick-deadline) */
export const chipOptionStyle: CSSProperties = {
  ...chipStyle,
  padding: "7px 14px",
  fontSize: f.md,
  borderColor: c.borderStrong,
  background: c.surface,
  color: c.text2,
  cursor: "pointer",
  minHeight: 36,
};

export const chipOptionSelectedStyle: CSSProperties = {
  ...chipOptionStyle,
  background: c.primary,
  borderColor: c.primary,
  color: c.onPrimary,
  fontWeight: 700,
};

export const chipAssignMeStyle: CSSProperties = {
  ...chipStyle,
  marginLeft: "auto",
  background: c.focusRingTint,
  border: `1px solid ${c.focusRingLine}`,
  color: c.focusRingInk,
  fontWeight: 700,
  padding: "5px 12px",
  cursor: "pointer",
};

export const chipOverdueStyle: CSSProperties = {
  ...chipStyle,
  background: c.danger,
  borderColor: c.danger,
  color: "#fff",
  fontWeight: 700,
};

/** read-only type chip (detail) */
export const chipTypeStyle: CSSProperties = {
  ...chipStyle,
  background: c.focusRingTint,
  borderColor: c.focusRingLine,
  color: c.focusRingInk,
};

export const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: s.s2,
};

export const quickChipsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: s.s2,
  marginBottom: s.s2,
};

export const fieldStyle: CSSProperties = { marginBottom: s.s3 };

export const fieldLabelStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  fontSize: f.md,
  fontWeight: 600,
  color: c.text,
  marginBottom: 6,
};

export const controlStyle: CSSProperties = {
  minHeight: 46,
  width: "100%",
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: s.s2,
  background: c.surface,
  border: `1px solid ${c.borderStrong}`,
  borderRadius: r.md,
  padding: `0 ${s.s3}px`,
  fontSize: f.base,
  fontFamily: font,
};

export const metaGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: `${s.s3}px ${s.s4}px`,
};

export const avatarStyle: CSSProperties = {
  width: 26,
  height: 26,
  flex: "0 0 auto",
  borderRadius: r.pill,
  display: "grid",
  placeItems: "center",
  color: "#fff",
  fontSize: 12,
  fontWeight: 700,
  background: c.focusRing,
};

export const projectChipStyle: CSSProperties = {
  background: c.surface2,
  border: `1px solid ${c.border}`,
  borderRadius: r.pill,
  padding: "2px 10px",
  fontWeight: 600,
  fontSize: f.sm,
  color: c.text2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

export const bottomBarStyle: CSSProperties = {
  flex: "0 0 auto",
  background: "rgba(255,255,255,0.94)",
  borderTop: `1px solid ${c.border}`,
  boxShadow: shadow.sticky,
  padding: `${s.s3}px ${s.s4}px`,
  display: "flex",
  flexDirection: "column",
  gap: s.s2,
};

export const buttonPrimaryStyle: CSSProperties = {
  minHeight: 46,
  borderRadius: r.md,
  border: "1px solid transparent",
  cursor: "pointer",
  fontFamily: font,
  fontSize: f.base,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: `0 ${s.s4}px`,
  background: c.primary,
  color: c.onPrimary,
};

export const buttonAccentStyle: CSSProperties = {
  ...buttonPrimaryStyle,
  background: "#e8a124",
  color: "#2b1a00",
};

export const buttonGhostStyle: CSSProperties = {
  ...buttonPrimaryStyle,
  background: c.surface,
  color: c.text2,
  borderColor: c.borderStrong,
};

export const fontStyle: CSSProperties = { fontFamily: font };

// ── Wave 11 · tasks toolbar band fragments (ADDITIVE — the existing
// values above are untouched). One control family for the whole bar:
// 36px height, `radius.md` corners, `borderStrong` hairline, the v2
// token font stack, and a focusRing-consistent focus treatment. ──────

/** Shared height for every toolbar button / select / search input. */
export const CONTROL_HEIGHT = 36;

/** Quiet pill chips sit a step below the controls (28px). */
export const CHIP_HEIGHT = 28;

/** The toolbar band itself (flex-wrap so it NEVER clips a control). */
export const toolbarBandStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: s.s2,
  padding: `${s.s2}px ${s.s3}px`,
  background: c.surface,
  borderBottom: `1px solid ${c.border}`,
  boxSizing: "border-box",
  fontFamily: font,
};

export const toolbarTitleStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: f.lg,
  fontWeight: 700,
  color: c.text,
  marginRight: s.s1,
  whiteSpace: "nowrap",
};

/** Quiet secondary control (sort select, Columns, Clear filters, outbox). */
export const toolbarControlStyle: CSSProperties = {
  height: CONTROL_HEIGHT,
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  boxSizing: "border-box",
  padding: `0 ${s.s3}px`,
  borderRadius: r.md,
  border: `1px solid ${c.borderStrong}`,
  background: c.surface,
  color: c.text2,
  fontFamily: font,
  fontSize: f.md,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  outline: "none",
  transition: "background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease, transform 60ms ease",
};

/** The bar's ONLY filled primary control (+ New task). */
export const toolbarPrimaryControlStyle: CSSProperties = {
  ...toolbarControlStyle,
  background: c.primary,
  borderColor: c.primary,
  color: c.onPrimary,
  fontWeight: 700,
};

/** Search field — same family, flex-grow with min/max discipline. */
export const toolbarInputStyle: CSSProperties = {
  height: CONTROL_HEIGHT,
  flex: "1 1 240px",
  minWidth: 180,
  maxWidth: 360,
  boxSizing: "border-box",
  display: "block",
  padding: `0 ${s.s3}px`,
  borderRadius: r.md,
  border: `1px solid ${c.borderStrong}`,
  background: c.surface,
  color: c.text,
  fontFamily: font,
  fontSize: f.md,
  outline: "none",
  transition: "border-color 120ms ease, box-shadow 120ms ease",
};

/** Neutral toolbar chip (status filters — inactive). */
export const toolbarChipStyle: CSSProperties = {
  height: CHIP_HEIGHT,
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
  padding: `0 ${s.s3}px`,
  borderRadius: r.pill,
  border: `1px solid ${c.borderStrong}`,
  background: c.surface,
  color: c.text2,
  fontFamily: font,
  fontSize: f.sm,
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
  outline: "none",
  transition: "background 120ms ease, border-color 120ms ease, box-shadow 120ms ease, color 120ms ease",
};

/** Selected toolbar chip — tinted-accent language (NOT filled primary,
 *  so + New task stays the only solid control in the bar). */
export const toolbarChipActiveStyle: CSSProperties = {
  ...toolbarChipStyle,
  background: c.focusRingTint,
  borderColor: c.focusRingLine,
  color: c.focusRingInk,
  fontWeight: 700,
};
// ── UI refresh v1 · module chrome fragments (ADDITIVE — every value
// below is composed from the tokens above; ZERO new hexes). Map:
// docs/ux/tasks-ui-refresh-v1.md §3 V1/V2/V3/V4/V5/V7. ──────────────

/** V1 — the module floats as a rounded card over `--canvas` (the
 *  NavPanel/PropertiesDrawer language: canvas owns the area, every UI
 *  piece floats). The wrapper around the table/board body. */
export const cardWrapperStyle: CSSProperties = {
  background: c.surface,
  border: `1px solid ${c.border}`,
  borderRadius: r.lg,
  boxShadow: shadow.raised,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
};

/** The padded canvas area the card floats in. */
export const canvasAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  padding: s.s3,
  background: c.canvas,
  boxSizing: "border-box",
};

/** V2 — segmented pill for the Table · Board view tabs. Same pill
 *  geometry as the Models viewer toolbar (`--r-pill` + borderStrong). */
export const segmentedPillStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  flex: "0 0 auto",
  height: CONTROL_HEIGHT,
  boxSizing: "border-box",
  border: `1px solid ${c.borderStrong}`,
  borderRadius: r.pill,
  background: c.surface,
  padding: 2,
  gap: 2,
  fontFamily: font,
};

export function segmentItemStyle(active: boolean): CSSProperties {
  return {
    height: CONTROL_HEIGHT - 6,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: `0 ${s.s3}px`,
    borderRadius: r.pill,
    border: "none",
    cursor: "pointer",
    fontFamily: font,
    fontSize: f.md,
    fontWeight: 600,
    whiteSpace: "nowrap",
    background: active ? c.primary : "transparent",
    color: active ? c.onPrimary : c.text2,
    transition: "background 120ms ease, color 120ms ease",
  };
}

/** V3 — soft status: quiet 8px dot + muted label (no filled block). */
export const softStatusStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: f.sm,
  fontWeight: 600,
  color: c.text2,
  whiteSpace: "nowrap",
};

export const softStatusDotStyle: CSSProperties = {
  width: 8,
  height: 8,
  flex: "0 0 auto",
  borderRadius: "50%",
  display: "inline-block",
};

/** V4 — group header row: sticky `--surface-2` band, uppercase xs
 *  caption like the rail captions, count badge + collapse caret. */
export const groupHeaderStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: c.surface2,
  borderBottom: `1px solid ${c.border}`,
  padding: `5px ${s.s3}px`,
  fontSize: f.xs,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  fontWeight: 700,
  color: c.muted,
  cursor: "pointer",
  userSelect: "none",
  whiteSpace: "nowrap",
};

/** V5 — avatar initials circle. Fill comes from the existing accent
 *  palette via `avatarAccent()`; list avatars run one step smaller. */
export const avatarMiniStyle: CSSProperties = {
  ...avatarStyle,
  width: 22,
  height: 22,
  fontSize: f.xs,
};

/** Overlapping stack for multi-party rows. */
export const avatarStackStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
};

/**
 * Deterministic accent pick for an avatar from the EXISTING
 * status-accent palette (no new hexes): hash the label into the
 * STATUS_HEX value set.
 */
const ACCENT_CYCLE = [
  STATUS_HEX.blue.bg,
  STATUS_HEX.teal.bg,
  STATUS_HEX.orange.bg,
  STATUS_HEX.green.bg,
  STATUS_HEX.red.bg,
  STATUS_HEX.yellow.bg,
  STATUS_HEX.gray.bg,
];

export function avatarAccent(seed: string | null | undefined): string {
  const s0 = (seed ?? "").trim().toLowerCase();
  if (!s0) return STATUS_HEX.gray.bg;
  let h = 0;
  for (let i = 0; i < s0.length; i++) h = (h * 31 + s0.charCodeAt(i)) >>> 0;
  return ACCENT_CYCLE[h % ACCENT_CYCLE.length] as string;
}

/** V7 — hover row-action button (⌖ · ✓ · ⋯): bare until hover row. */
export const hoverActionStyle: CSSProperties = {
  width: 26,
  height: 26,
  display: "inline-grid",
  placeItems: "center",
  border: `1px solid transparent`,
  borderRadius: r.sm,
  background: "transparent",
  color: c.text2,
  fontSize: f.base,
  cursor: "pointer",
  padding: 0,
  fontFamily: font,
};

/** V9 — the ⌘K hint badge inside the search field (cosmetic). */
export const kbdHintStyle: CSSProperties = {
  position: "absolute",
  right: 8,
  top: "50%",
  transform: "translateY(-50%)",
  pointerEvents: "none",
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  border: `1px solid ${c.borderStrong}`,
  borderRadius: r.sm,
  background: c.surface2,
  color: c.muted,
  fontFamily: font,
  fontSize: f.xs,
  fontWeight: 600,
  lineHeight: 1,
  padding: "3px 5px",
};

/** §2 — the building-scope chip (⌒ NAME ▾) + This/All micro toggle. */
export const scopeChipStyle: CSSProperties = {
  ...chipStyle,
  height: CHIP_HEIGHT,
  padding: `0 ${s.s3}px`,
  fontWeight: 700,
  color: c.text,
  background: c.surface2,
  fontFamily: font,
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

/** Second toolbar band (view tabs · scope · views · grouping). */
export const toolbarSubBandStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: s.s2,
  padding: `${s.s1 + 2}px ${s.s3}px`,
  background: c.surface2,
  borderBottom: `1px solid ${c.border}`,
  boxSizing: "border-box",
  fontFamily: font,
};
// ── Wave 53 · floating-card sheet shell (compose/detail) ───────────
// The former right-anchored drawer becomes a centered floating card over
// `--scrim` on desktop (`useIsWide` ≥768px) and a full-height sheet on
// phones. Composed from the tokens above — ZERO new hexes. ─────────────

/** Desktop backdrop — `--scrim` dims the page; a click closes the sheet
 *  (hosts stop propagation on the card). */
export const sheetScrimStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: c.scrim,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: s.s4,
  zIndex: 40,
  boxSizing: "border-box",
};

/** Desktop floating card — rounded `--r-lg`, `--shadow-raised`, ~460px,
 *  vertically centered; inner scroll with the header/footer pinned. */
export const sheetCardStyle: CSSProperties = {
  position: "relative",
  width: 460,
  maxWidth: "100%",
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  background: c.surface,
  borderRadius: r.lg,
  boxShadow: shadow.raised,
  overflow: "hidden",
  fontFamily: font,
  color: c.text,
};

/** Mobile — full-height sheet (the v2 mockups are mobile-width; only the
 *  desktop gets the floating card treatment). */
export const sheetFullHeightStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: c.bg,
  fontFamily: font,
  color: c.text,
};
