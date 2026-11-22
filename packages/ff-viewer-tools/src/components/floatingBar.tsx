// Shared bottom-centre floating tool bar: the frosted container, the
// segmented "Label ▾" buttons, the dropdown menu and its rows, plus the
// readout chip and small action buttons. Used by the Models 3D toolbar
// and the Documents PDF measure bar so both look and behave the same.
// Token values are literals (mirroring the tasks-react tokens) so this
// package does not depend on tasks-react.

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import "../frosted.css";

export const BAR_TOKENS = {
  surface: "#ffffff",
  borderStrong: "#d6dbe1",
  text: "#1b1f24",
  text2: "#5b626b",
  primary: "#181c22",
  onPrimary: "#ffffff",
  focusRing: "#2f6fe4",
  danger: "#d64545",
  focusRingTint: "rgba(47,111,228,0.08)",
  focusRingLine: "rgba(47,111,228,0.22)",
  focusRingInk: "#2a5bb8",
  warnTint: "rgba(217,119,6,0.10)",
  warnLine: "rgba(217,119,6,0.30)",
  warnInk: "#8a5a00",
  fontSm: 12,
  fontMd: 13,
  font: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif',
} as const;

const t = BAR_TOKENS;

export function floatingBarAnchorStyle(isMobile: boolean): CSSProperties {
  return isMobile
    ? { left: "auto", right: 12, transform: "none", alignItems: "flex-end" }
    : { left: "50%", right: "auto", transform: "translateX(-50%)", alignItems: "center" };
}

export interface FloatingBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "className"> {
  isMobile?: boolean;
  /** extra inline style merged over the defaults */
  style?: CSSProperties;
  children?: ReactNode;
}

/** Frosted, absolutely positioned bottom-centre container (right-aligned on mobile). */
export function FloatingBar({ isMobile = false, style, children, ...rest }: FloatingBarProps) {
  return (
    <div
      role="toolbar"
      {...rest}
      className="ff-frosted ff-viewer-toolbar"
      style={{
        position: "absolute",
        bottom: 14,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderRadius: 14,
        ...floatingBarAnchorStyle(isMobile),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function barRowStyle(): CSSProperties {
  return { display: "flex", alignItems: "center", gap: 8, padding: 4, borderRadius: 14, fontFamily: t.font };
}

export function segGroupStyle(): CSSProperties {
  return { display: "flex", gap: 2, background: "transparent", border: "none", borderRadius: 14, padding: 0 };
}

export function segButtonStyle(on: boolean): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px",
    border: "none",
    borderRadius: 999,
    background: on ? "#ffffff" : "transparent",
    color: on ? t.focusRing : t.text2,
    fontSize: t.fontMd,
    fontWeight: on ? 700 : 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
    boxShadow: on ? "0 2px 8px rgba(16,24,40,0.12)" : "none",
    transition: "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}

export function menuStyle(): CSSProperties {
  return { display: "flex", flexDirection: "column", gap: 2, minWidth: 200, borderRadius: 12, padding: 6, fontFamily: t.font };
}

export function menuRowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "9px 12px",
    borderRadius: 8,
    border: "none",
    background: active ? t.primary : "transparent",
    color: active ? t.onPrimary : t.text,
    fontSize: t.fontMd,
    fontWeight: active ? 700 : 600,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };
}

export function readoutChipStyle(tone: "info" | "warn" = "info"): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    padding: "0 12px",
    background: tone === "warn" ? t.warnTint : t.focusRingTint,
    border: `1px solid ${tone === "warn" ? t.warnLine : t.focusRingLine}`,
    borderRadius: 999,
    color: tone === "warn" ? t.warnInk : t.focusRingInk,
    fontSize: t.fontSm,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  };
}

export function clearButtonStyle(kind: "clear" | "done" = "clear"): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "0 12px",
    border: `1px solid ${t.borderStrong}`,
    borderRadius: 12,
    background: t.surface,
    color: kind === "done" ? t.focusRingInk : t.danger,
    fontSize: t.fontSm,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
}
