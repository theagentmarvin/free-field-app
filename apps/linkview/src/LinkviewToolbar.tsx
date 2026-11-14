// apps/linkview/src/LinkviewToolbar.tsx
//
// Wave 52 — floating VIEWER TOOLS toolbar (bottom-center band) over
// the Linkview RIGHT (3D) pane. Same frosted segmented composition
// as the Models <ViewerToolbar> (wave 13/50).
//
// Wave 55: the Split View | Overlap mode toggle moved OUT of here
// into the TOOLS toolbar (<LinkviewNavToolbar>, top-left) — per
// docs/ux/toolbar-nomenclature.md the viewer tools toolbar carries
// direct viewer tools ONLY.
//
// Tools:
//   - Measure ▾     (Length · Area · Angle · Volume + live readout)
//   - Save view ▾   (Save view… / Saved views ▸)
//   - PDF opacity   (Overlap mode only — wave 63 slider, 0–100 %)
//
// The measure + save-view state machine is reused from the Models
// `toolbarState.ts` (pure, unit-tested); the saved-viewpoint encode/
// decode + restore logic is reused from Models `viewpointStore.ts`.
// The viewer tool-mode store (`viewerToolModeStore`) is shared with
// the surface's right-click context toolbar so it suppresses itself
// while measure is armed.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { requireProjectId } from "@ff/auth";
import { useIsMobile } from "@ff/viewer-tools";
import type { IfcViewerHandle, MeasureReadout } from "@ff/viewer-react";
import {
  createViewerViewpoint,
  deleteViewerViewpoint,
  listViewerViewpoints,
} from "@ff/data";
import type { ViewerViewpointRecord } from "@ff/types";

import {
  MEASURE_VARIANTS,
  VARIANT_LABELS,
  chooseVariant,
  closeToolMenu,
  formatMeasureReadout,
  initialToolbarState,
  openViewsMenu,
  selectTool,
  toggleMeasureMenu,
  toggleSaveMenu,
  type MeasureVariant,
  type ToolbarState,
} from "../../models/src/toolbarState";
import {
  MAX_VIEWPOINTS_PER_PROJECT,
  captureViewpointSnapshot,
  encodeViewpointBlob,
  decodeViewpointBlob,
  restoreViewpoint,
} from "../../models/src/viewpointStore";
import { useViewerToolModeStore } from "../../models/src/viewerToolModeStore";
import { useOverlayOpacityStore } from "./overlayOpacityStore";

import "../../models/src/frosted.css";

// Local copy of the tasks-v2 design tokens (the Models <ViewerToolbar>
// imports them from @ff/tasks-react; importing that barrel here would
// pull the firebase chain into the Linkview test graph). Values are
// identical to packages/ff-tasks-react/src/formStyles.ts.
const c = {
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
};
const r = { sm: 8, md: 12, lg: 16, pill: 999 };
const s = { s1: 4, s2: 8 };
const f = { xs: 11, sm: 12, md: 13 };
const font =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif';

export interface LinkviewToolbarProps {
  /** Resolve the live (shared) viewer handle (may be null before mount). */
  getHandle: () => IfcViewerHandle | null;
  /** Project the saved-viewpoints rows are scoped to. */
  projectId: string;
  /** Wave 63: show the PDF-overlay opacity slider (Overlap mode only). */
  showOverlayOpacity?: boolean;
}

export default function LinkviewToolbar({
  getHandle,
  projectId,
  showOverlayOpacity = false,
}: LinkviewToolbarProps): JSX.Element {
  const [state, setState] = useState<ToolbarState>(initialToolbarState);
  const [readout, setReadout] = useState<MeasureReadout | null>(null);
  const [viewpoints, setViewpoints] = useState<ViewerViewpointRecord[]>([]);
  const [saveName, setSaveName] = useState("");
  const [promptingSave, setPromptingSave] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const overlayOpacityPct = useOverlayOpacityStore((st) => st.pct);
  const setOverlayOpacityPct = useOverlayOpacityStore((st) => st.setPct);
  const opacityInputId = useId();

  const getHandleRef = useRef(getHandle);
  getHandleRef.current = getHandle;

  const stateRef = useRef(state);
  stateRef.current = state;
  const promptingSaveRef = useRef(promptingSave);
  promptingSaveRef.current = promptingSave;

  // Publish the tool mode so the surface's right-click context toolbar
  // suppresses itself while measure is armed (same store as Models).
  const setViewerToolMode = useViewerToolModeStore((s) => s.setMode);

  useEffect(() => {
    setViewerToolMode(state.mode === "measure" ? "measure" : "navigation");
  }, [state.mode, setViewerToolMode]);

  useEffect(() => {
    const h = getHandleRef.current();
    if (!h) return;
    if (state.mode === "measure") {
      h.setMeasureMode("measure", state.variant);
    } else {
      h.setMeasureMode("select");
    }
  }, [state.mode, state.variant]);

  useEffect(() => {
    const h = getHandleRef.current();
    if (!h || state.mode !== "measure") {
      setReadout(null);
      return;
    }
    h.onMeasureReadout(setReadout);
    return () => {
      h.onMeasureReadout(null);
    };
  }, [state.mode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key !== "Escape") return;
      if (stateRef.current.menu !== null || promptingSaveRef.current) {
        setState((s) => closeToolMenu(s));
        setPromptingSave(false);
        setSaveName("");
        return;
      }
      if (stateRef.current.mode === "measure") {
        const h = getHandleRef.current();
        if (h && h.isMeasureInProgress()) {
          h.cancelMeasureCreation();
          return;
        }
        setState((s) => selectTool(s));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (state.menu !== "views") return;
    let cancelled = false;
    (async () => {
      try {
        const rows = await listViewerViewpoints(projectId);
        if (!cancelled) setViewpoints(rows);
      } catch {
        if (!cancelled) setViewpoints([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.menu, projectId]);

  const measureLabel =
    state.mode === "measure"
      ? `Measure \u00b7 ${VARIANT_LABELS[state.variant]}`
      : "Measure";

  const handleMeasureToggle = (): void =>
    setState((s) => toggleMeasureMenu(s));
  const handleChooseVariant = (v: MeasureVariant): void =>
    setState((s) => chooseVariant(s, v));
  const handleClearMeasure = (): void => {
    getHandleRef.current()?.clearMeasurements();
    setReadout(null);
  };
  const handleSaveViewToggle = (): void => {
    setPromptingSave(false);
    setNotice(null);
    setState((s) => toggleSaveMenu(s));
  };
  const handleSaveViewPrompt = (): void => {
    setPromptingSave(true);
    setSaveName("");
    setNotice(null);
  };
  const submitSaveView = async (): Promise<void> => {
    const h = getHandleRef.current();
    const name = saveName.trim();
    if (!h || !name) return;
    const snap = captureViewpointSnapshot(h);
    try {
      await createViewerViewpoint({
        projectId: requireProjectId(projectId),
        name,
        blob: encodeViewpointBlob(snap),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[LinkviewToolbar] save viewpoint failed:", err);
      setNotice("Save failed");
      return;
    }
    setPromptingSave(false);
    setSaveName("");
    setState((s) => closeToolMenu(s));
    setNotice(null);
  };
  const handleRestoreViewpoint = (row: ViewerViewpointRecord): void => {
    const h = getHandleRef.current();
    if (!h) return;
    const snap = decodeViewpointBlob(row.blob);
    if (!snap) {
      setNotice("Unrestorable view");
      return;
    }
    restoreViewpoint(h, snap);
    setState((s) => closeToolMenu(s));
  };
  const handleDeleteViewpoint = async (id: string): Promise<void> => {
    await deleteViewerViewpoint(id);
    try {
      setViewpoints(await listViewerViewpoints(projectId));
    } catch {
      setViewpoints([]);
    }
  };

  const anchorStyle: CSSProperties = isMobile
    ? { left: "auto", right: 12, transform: "none", alignItems: "flex-end" }
    : { left: "50%", right: "auto", transform: "translateX(-50%)", alignItems: "center" };

  return (
    <div
      data-testid="linkview-toolbar"
      role="toolbar"
      aria-label="Linkview tools"
      className="ff-frosted ff-viewer-toolbar"
      style={{
        position: "absolute",
        bottom: 14,
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        borderRadius: 14,
        ...anchorStyle,
      }}
    >
      {state.menu === "measure" && (
        <div data-testid="linkview-toolbar-measure-menu" role="menu" aria-label="Measurement variants" className="ff-frosted" style={menuStyle()}>
          {MEASURE_VARIANTS.map((v) => {
            const active = state.mode === "measure" && state.variant === v;
            return (
              <button
                key={v}
                type="button"
                role="menuitem"
                data-testid={`linkview-toolbar-variant-${v}`}
                aria-current={active ? "true" : undefined}
                onClick={() => handleChooseVariant(v)}
                style={menuRowStyle(active)}
              >
                {VARIANT_LABELS[v]}
              </button>
            );
          })}
        </div>
      )}

      {state.menu === "save" && (
        <div data-testid="linkview-toolbar-save-menu" role="menu" aria-label="Save view options" className="ff-frosted" style={menuStyle()}>
          <button type="button" role="menuitem" data-testid="linkview-toolbar-save-view" onClick={handleSaveViewPrompt} style={menuRowStyle(false)}>
            Save view…
          </button>
          <button type="button" role="menuitem" data-testid="linkview-toolbar-saved-views" aria-haspopup="menu" onClick={() => setState((s) => openViewsMenu(s))} style={menuRowStyle(false)}>
            Saved views <span aria-hidden>▸</span>
          </button>
          {promptingSave && (
            <div data-testid="linkview-toolbar-save-form" style={{ display: "flex", gap: 6, padding: "6px 6px 2px" }}>
              <input
                autoFocus
                data-testid="linkview-toolbar-save-input"
                aria-label="View name"
                placeholder="View name"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submitSaveView();
                  if (e.key === "Escape") {
                    setPromptingSave(false);
                    setSaveName("");
                  }
                }}
                style={{ flex: 1, minWidth: 0, height: 32, padding: "0 8px", border: `1px solid ${c.borderStrong}`, borderRadius: 8, fontSize: f.md, fontFamily: "inherit" }}
              />
              <button type="button" data-testid="linkview-toolbar-save-confirm" onClick={() => void submitSaveView()} style={{ height: 32, padding: "0 10px", border: "none", borderRadius: 8, background: c.primary, color: c.onPrimary, fontSize: f.sm, fontWeight: 700, cursor: "pointer" }}>
                Save
              </button>
            </div>
          )}
        </div>
      )}

      {state.menu === "views" && (
        <div data-testid="linkview-toolbar-views-menu" role="menu" aria-label="Saved views" className="ff-frosted" style={menuStyle()}>
          <div style={{ padding: "4px 12px 8px", fontSize: f.sm, fontWeight: 700, color: c.text2 }}>
            Saved views ({viewpoints.length}/{MAX_VIEWPOINTS_PER_PROJECT})
          </div>
          {viewpoints.length === 0 ? (
            <div data-testid="linkview-toolbar-views-empty" style={{ padding: "4px 12px 8px", fontSize: f.sm, color: c.muted }}>
              No saved views yet.
            </div>
          ) : (
            viewpoints.map((row) => (
              <div key={row.id} data-testid={`linkview-toolbar-view-${row.id}`} style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 6px" }}>
                <button type="button" role="menuitem" data-testid={`linkview-toolbar-restore-${row.id}`} onClick={() => handleRestoreViewpoint(row)} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "9px 6px", borderRadius: 8, border: "none", background: "transparent", color: c.text, fontSize: f.md, fontWeight: 600, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                  {row.name}
                </button>
                <button type="button" data-testid={`linkview-toolbar-delete-${row.id}`} aria-label={`Delete ${row.name}`} onClick={() => void handleDeleteViewpoint(row.id)} style={{ height: 28, minWidth: 28, border: "none", borderRadius: 8, background: "transparent", color: c.danger, fontSize: f.md, fontWeight: 700, cursor: "pointer" }}>
                  ×
                </button>
              </div>
            ))
          )}
          {notice && <div data-testid="linkview-toolbar-notice" style={{ padding: "4px 12px 8px", fontSize: f.sm, color: c.danger }}>{notice}</div>}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: s.s2, padding: 4, borderRadius: 14, fontFamily: font }}>
        {/* ── Measure / Save view ───────────────────────────────── */}
        <div role="group" aria-label="Measure or save view" style={{ display: "flex", gap: 2, background: "transparent", border: "none", borderRadius: 14, padding: 0 }}>
          <button
            type="button"
            data-testid="linkview-toolbar-measure"
            aria-pressed={state.mode === "measure"}
            aria-haspopup="menu"
            aria-expanded={state.menu === "measure"}
            onClick={handleMeasureToggle}
            style={segButtonStyle(state.mode === "measure")}
          >
            {"\u{1F4CF}"} {measureLabel}
            <span aria-hidden style={{ fontSize: 10, marginLeft: 2 }}>{"\u25BE"}</span>
          </button>
          <button
            type="button"
            data-testid="linkview-toolbar-save-view-button"
            aria-pressed={state.menu === "save" || state.menu === "views"}
            aria-haspopup="menu"
            aria-expanded={state.menu === "save" || state.menu === "views"}
            onClick={handleSaveViewToggle}
            style={segButtonStyle(state.menu === "save" || state.menu === "views")}
          >
            {"\u{1F4BE}"} Save view
            <span aria-hidden style={{ fontSize: 10, marginLeft: 2 }}>{"\u25BE"}</span>
          </button>
        </div>

        {state.mode === "measure" && (
          <>
            {formatMeasureReadout(readout) && (
              <span data-testid="linkview-toolbar-readout" style={readoutChipStyle()}>
                {formatMeasureReadout(readout)}
              </span>
            )}
            <button type="button" data-testid="linkview-toolbar-clear" aria-label="Clear measurements" onClick={handleClearMeasure} style={clearButtonStyle()}>
              {"\u232B"} clear
            </button>
          </>
        )}

        {/* ── Wave 63: PDF overlay opacity (Overlap only) ────────── */}
        {showOverlayOpacity && (
          <div
            role="group"
            aria-label="PDF overlay"
            data-testid="linkview-toolbar-overlay-opacity-group"
            style={opacityGroupStyle()}
          >
            <label htmlFor={opacityInputId} style={{ fontSize: f.md, fontWeight: 600, color: c.text2, whiteSpace: "nowrap", cursor: "pointer" }}>
              PDF opacity
            </label>
            <input
              id={opacityInputId}
              type="range"
              min={0}
              max={100}
              step={1}
              value={overlayOpacityPct}
              aria-valuetext={`${overlayOpacityPct}%`}
              data-testid="linkview-toolbar-overlay-opacity"
              onChange={(e) => setOverlayOpacityPct(Number(e.target.value))}
              style={{ width: isMobile ? 84 : 120, accentColor: c.focusRing, cursor: "pointer" }}
            />
            <output
              htmlFor={opacityInputId}
              data-testid="linkview-toolbar-overlay-opacity-value"
              aria-hidden
              style={{ minWidth: 36, textAlign: "right", fontSize: f.sm, fontWeight: 700, color: c.text, fontVariantNumeric: "tabular-nums" }}
            >
              {overlayOpacityPct}%
            </output>
          </div>
        )}
      </div>
    </div>
  );
}

function segButtonStyle(on: boolean): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0 12px",
    border: "none",
    borderRadius: 999,
    background: on ? "#ffffff" : "transparent",
    color: on ? c.focusRing : c.text2,
    fontSize: f.md,
    fontWeight: on ? 700 : 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
    boxShadow: on ? "0 2px 8px rgba(16,24,40,0.12)" : "none",
    transition: "background 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}

function opacityGroupStyle(): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "0 12px",
    borderLeft: `1px solid ${c.border}`,
    fontFamily: "inherit",
  };
}

function menuStyle(): CSSProperties {
  return {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 200,
    borderRadius: 12,
    padding: 6,
    fontFamily: font,
  };
}

function menuRowStyle(active: boolean): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "9px 12px",
    borderRadius: 8,
    border: "none",
    background: active ? c.primary : "transparent",
    color: active ? c.onPrimary : c.text,
    fontSize: f.md,
    fontWeight: active ? 700 : 600,
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
  };
}

function readoutChipStyle(): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    padding: "0 12px",
    background: c.focusRingTint,
    border: `1px solid ${c.focusRingLine}`,
    borderRadius: r.pill,
    color: c.focusRingInk,
    fontSize: f.sm,
    fontWeight: 700,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
  };
}

function clearButtonStyle(): CSSProperties {
  return {
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "0 12px",
    border: `1px solid ${c.borderStrong}`,
    borderRadius: r.md,
    background: c.surface,
    color: c.danger,
    fontSize: f.sm,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
}