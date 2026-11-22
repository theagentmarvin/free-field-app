import {
  useEffect,
  useRef,
  useState,

} from "react";

import { tokens } from "@ff/tasks-react";
import {
  FloatingBar,
  barRowStyle,
  clearButtonStyle,
  menuRowStyle,
  menuStyle,
  readoutChipStyle,
  segButtonStyle,
  segGroupStyle,
  useIsMobile,
  useManualVisibilityStore,
} from "@ff/viewer-tools";
import type {
  IfcViewerHandle,
  MeasureReadout,
  MeasurementEntry,
} from "@ff/viewer-react";
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
  measureHint,
  measureNeedsFinish,
  openViewsMenu,
  selectTool,
  toggleListMenu,
  toggleMeasureMenu,
  toggleSaveMenu,
  type MeasureVariant,
  type ToolbarState,
} from "./toolbarState";
import {
  MAX_VIEWPOINTS_PER_PROJECT,
  captureViewpointSnapshot,
  decodeViewpointBlob,
  deserializeVisibility,
  encodeViewpointBlob,
  restoreViewpoint,
} from "./viewpointStore";

import "./frosted.css";
import { useViewerToolModeStore } from "./viewerToolModeStore";

const { color: c, fontSize: f } = tokens;

/**
 * <ViewerToolbar> (Wave 13, trimmed in Wave 50) — floating bottom band
 * over the 3D viewer: a `[📏 Measure ▾] [💾 Save view ▾]` segmented
 * control.
 *
 *  - Measure caret opens the variant menu (Length · Area · Angle ·
 *    Volume); while measuring the bar gains a clear button plus a live
 *    readout chip fed by `onMeasureReadout`.
 *  - Save view caret opens the save-view menu (Save view… / Saved
 *    views ▸). The Select + Section buttons were removed in wave 50:
 *    navigation is the default mode (no toggle), and sectioning lives
 *    only in the right-click context toolbar (wave 47/49).
 *  - Saved views are persisted to the local Dexie `viewerViewpoints`
 *    table (demo AND cloud both local for now), capped at 12/project.
 *
 * Positioning matches Wave 12: centred on desktop, bottom-right on
 * phones so it clears the bottom-LEFT task pill.
 */

export interface ViewerToolbarProps {
  /** Resolve the live viewer handle (may be null before mount). */
  getHandle: () => IfcViewerHandle | null;
  /** Project the saved-viewpoints rows are scoped to. */
  projectId: string;
}

export default function ViewerToolbar({
  getHandle,
  projectId,
}: ViewerToolbarProps): JSX.Element {
  const [state, setState] = useState<ToolbarState>(initialToolbarState);
  const [readout, setReadout] = useState<MeasureReadout | null>(null);
  // Wave 67: measurements on screen (3D + open level plan) + the list
  // row the camera was last sent to.
  const [entries, setEntries] = useState<MeasurementEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Saved-viewpoints list (re-read every time the views sub-menu opens).
  const [viewpoints, setViewpoints] = useState<ViewerViewpointRecord[]>([]);
  // Inline save-view name prompt + transient error/notice text.
  const [saveName, setSaveName] = useState("");
  const [promptingSave, setPromptingSave] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Keep the latest `getHandle` in a ref so the effects below can
  // depend only on the state they react to (not on a fresh arrow
  // function identity every render).
  const getHandleRef = useRef(getHandle);
  getHandleRef.current = getHandle;

  // Mirrors of state read inside the stable window keydown handler.
  const stateRef = useRef(state);
  stateRef.current = state;
  const promptingSaveRef = useRef(promptingSave);
  promptingSaveRef.current = promptingSave;

  // Wave 47 — publish the tool mode so the right-click context toolbar
  // can suppress itself while measure is armed. (wave 50: no more
  // "section" branch — sectioning now lives in the context toolbar.)
  const setViewerToolMode = useViewerToolModeStore((s) => s.setMode);

  useEffect(() => {
    setViewerToolMode(state.mode === "measure" ? "measure" : "navigation");
  }, [state.mode, setViewerToolMode]);

  // ── mirror mode/variant onto the viewer handle ────────────────
  useEffect(() => {
    const h = getHandleRef.current();
    if (!h) return;
    if (state.mode === "measure") {
      h.setMeasureMode("measure", state.variant);
    } else {
      h.setMeasureMode("select");
    }
  }, [state.mode, state.variant]);

  // ── subscribe to the live readout feed ────────────────────────
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

  // ── Wave 67: keep the measurements list in sync with the viewer ─
  // Independent of the tool mode: measurements outlive the armed tool.
  // The handle may not exist on the very first effect pass, so retry
  // briefly until it does.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let subscribed: IfcViewerHandle | null = null;
    const attach = (attempt: number): void => {
      if (cancelled) return;
      const h = getHandleRef.current();
      if (!h || typeof h.onMeasurementsChange !== "function") {
        if (attempt < 40) timer = setTimeout(() => attach(attempt + 1), 250);
        return;
      }
      subscribed = h;
      setEntries(h.getMeasurements?.() ?? []);
      h.onMeasurementsChange?.((next) => {
        setEntries(next);
        setActiveId((cur) => (cur && next.some((e) => e.id === cur) ? cur : null));
      });
    };
    attach(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      subscribed?.onMeasurementsChange?.(null);
    };
  }, []);

  // ── Escape: menus/save-form dismiss; measure two-stage escape ─
  // Wave 50: the viewer owns the cancel-vs-exit decision for the
  // measure tool. Escape dismisses an open menu/save-form first (those
  // have their own dismissal); otherwise it consults the viewer handle:
  // in-progress → cancel the current line (stay armed), idle → exit to
  // navigation (`selectTool` → `setMeasureMode("select")`).
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
          // Stage 1: cancel the current line, tool stays armed.
          h.cancelMeasureCreation();
          return;
        }
        // Stage 2: idle → exit to navigation.
        setState((s) => selectTool(s));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── load saved viewpoints whenever the views sub-menu opens ──
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
    setActiveId(null);
  };
  const handleListToggle = (): void => {
    if (state.menu === "list") {
      void getHandleRef.current()?.focusMeasurement?.(null);
      setActiveId(null);
    }
    setState((s) => toggleListMenu(s));
  };
  const handleFocusEntry = (id: string): void => {
    setActiveId(id);
    void getHandleRef.current()?.focusMeasurement?.(id);
  };
  const handleDeleteEntry = (id: string): void => {
    getHandleRef.current()?.deleteMeasurement?.(id);
  };
  const handleFinish = (): void => {
    getHandleRef.current()?.finishMeasureCreation?.();
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
    // Wave 63: read the current count so the form can warn when saving
    // will evict the oldest view (the data layer caps at 12).
    void listViewerViewpoints(projectId).then(
      (rows) => setViewpoints(rows),
      () => undefined,
    );
  };

  const submitSaveView = async (): Promise<void> => {
    const h = getHandleRef.current();
    const name = saveName.trim();
    if (!h || !name) return;
    // Wave 54 — capture the manual hide/isolate overlay alongside the
    // camera + section planes so restoring a view brings back exactly
    // what was hidden/isolated at save time.
    const snap = captureViewpointSnapshot(
      h,
      useManualVisibilityStore.getState(),
    );
    try {
      await createViewerViewpoint({
        projectId,
        name,
        blob: encodeViewpointBlob(snap),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ViewerToolbar] save viewpoint failed:", err);
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
    restoreViewpoint(h, snap, (v) => {
      // Wave 54 — replace the live overlay wholesale; the filter effect
      // re-applies the merged visibility on the store change. Wave 63:
      // a view saved with nothing hidden (`null`) clears the overlay.
      useManualVisibilityStore
        .getState()
        .replaceOverlay(v ? deserializeVisibility(v) : null);
    });
    setState((s) => closeToolMenu(s));
  };

  const handleDeleteViewpoint = async (id: string): Promise<void> => {
    // Wave 63: a rejected delete used to escape as an unhandled
    // rejection (the click handler voids the promise).
    try {
      await deleteViewerViewpoint(id);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ViewerToolbar] delete viewpoint failed:", err);
      setNotice("Delete failed");
      return;
    }
    try {
      setViewpoints(await listViewerViewpoints(projectId));
    } catch {
      setViewpoints([]);
    }
  };

  return (
    <FloatingBar
      data-testid="viewer-toolbar"
      aria-label="Viewer tools"
      isMobile={isMobile}
    >
      {/* ── Measure variant menu ───────────────────────────────── */}
      {state.menu === "measure" && (
        <div
          data-testid="viewer-toolbar-menu"
          role="menu"
          aria-label="Measurement variants"
          className="ff-frosted"
          style={menuStyle()}
        >
          {MEASURE_VARIANTS.map((v) => {
            const active = state.mode === "measure" && state.variant === v;
            return (
              <button
                key={v}
                type="button"
                role="menuitem"
                data-testid={`viewer-toolbar-variant-${v}`}
                aria-current={active ? "true" : undefined}
                onClick={() => handleChooseVariant(v)}
                onBlur={() => state.menu && setState((s) => closeToolMenu(s))}
                style={menuRowStyle(active)}
              >
                {VARIANT_LABELS[v]}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Measurements list (wave 67) ────────────────────────── */}
      {state.menu === "list" && (
        <div
          data-testid="viewer-toolbar-list"
          role="menu"
          aria-label="Measurements"
          className="ff-frosted"
          style={{ ...menuStyle(), minWidth: 260, maxHeight: 280, overflowY: "auto" }}
        >
          {entries.length === 0 ? (
            <div
              data-testid="viewer-toolbar-list-empty"
              style={{ padding: "8px 12px", fontSize: f.sm, color: c.text2 }}
            >
              No measurements yet
            </div>
          ) : (
            entries.map((e) => (
              <div
                key={e.id}
                data-testid={`viewer-toolbar-list-row-${e.id}`}
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`viewer-toolbar-list-focus-${e.id}`}
                  aria-current={activeId === e.id ? "true" : undefined}
                  title="Show in view"
                  onClick={() => handleFocusEntry(e.id)}
                  style={{ ...menuRowStyle(activeId === e.id), flex: 1 }}
                >
                  <span>{e.label}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>
                    {e.text}
                  </span>
                </button>
                <button
                  type="button"
                  data-testid={`viewer-toolbar-list-delete-${e.id}`}
                  aria-label={`Delete ${e.label}`}
                  onClick={() => handleDeleteEntry(e.id)}
                  style={{
                    height: 32,
                    minWidth: 32,
                    border: "none",
                    borderRadius: 8,
                    background: "transparent",
                    color: c.danger,
                    fontSize: f.md,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {"\u00d7"}
                </button>
              </div>
            ))
          )}
          {entries.length > 0 && (
            <button
              type="button"
              data-testid="viewer-toolbar-list-clear"
              onClick={handleClearMeasure}
              style={{ ...menuRowStyle(false), color: c.danger, justifyContent: "center" }}
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* ── Save-view menu ─────────────────────────────────────── */}
      {state.menu === "save" && (
        <div
          data-testid="viewer-toolbar-save-view-menu"
          role="menu"
          aria-label="Save view options"
          className="ff-frosted"
          style={menuStyle()}
        >
          <button
            type="button"
            role="menuitem"
            data-testid="viewer-toolbar-save-view"
            onClick={handleSaveViewPrompt}
            style={menuRowStyle(false)}
          >
            Save view…
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="viewer-toolbar-saved-views"
            aria-haspopup="menu"
            onClick={() => setState((s) => openViewsMenu(s))}
            style={menuRowStyle(false)}
          >
            Saved views <span aria-hidden>▸</span>
          </button>

          {promptingSave && (
            <div
              data-testid="viewer-toolbar-save-form"
              style={{ display: "flex", gap: 6, padding: "6px 6px 2px" }}
            >
              <input
                autoFocus
                data-testid="viewer-toolbar-save-input"
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
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 32,
                  padding: "0 8px",
                  border: `1px solid ${c.borderStrong}`,
                  borderRadius: 8,
                  fontSize: f.md,
                  fontFamily: "inherit",
                }}
              />
              <button
                type="button"
                data-testid="viewer-toolbar-save-confirm"
                onClick={() => void submitSaveView()}
                style={{
                  height: 32,
                  padding: "0 10px",
                  border: "none",
                  borderRadius: 8,
                  background: c.primary,
                  color: c.onPrimary,
                  fontSize: f.sm,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </div>
          )}
          {promptingSave &&
            viewpoints.length >= MAX_VIEWPOINTS_PER_PROJECT && (
              <div
                data-testid="viewer-toolbar-save-cap-warning"
                role="status"
                style={{
                  padding: "4px 8px 2px",
                  fontSize: f.sm,
                  color: c.danger,
                  maxWidth: 240,
                }}
              >
                {MAX_VIEWPOINTS_PER_PROJECT} views saved — saving replaces the
                oldest{viewpoints[0] ? ` (“${viewpoints[0].name}”)` : ""}.
              </div>
            )}
        </div>
      )}

      {/* ── Saved views sub-menu ───────────────────────────────── */}
      {state.menu === "views" && (
        <div
          data-testid="viewer-toolbar-views-menu"
          role="menu"
          aria-label="Saved views"
          className="ff-frosted"
          style={menuStyle()}
        >
          <div
            style={{
              padding: "4px 12px 8px",
              fontSize: f.sm,
              fontWeight: 700,
              color: c.text2,
            }}
          >
            Saved views ({viewpoints.length}/{MAX_VIEWPOINTS_PER_PROJECT})
          </div>
          {viewpoints.length === 0 ? (
            <div
              data-testid="viewer-toolbar-views-empty"
              style={{ padding: "4px 12px 8px", fontSize: f.sm, color: c.muted }}
            >
              No saved views yet.
            </div>
          ) : (
            viewpoints.map((row) => (
              <div
                key={row.id}
                data-testid={`viewer-toolbar-view-${row.id}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 6px",
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  data-testid={`viewer-toolbar-restore-${row.id}`}
                  onClick={() => handleRestoreViewpoint(row)}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "9px 6px",
                    borderRadius: 8,
                    border: "none",
                    background: "transparent",
                    color: c.text,
                    fontSize: f.md,
                    fontWeight: 600,
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                  }}
                >
                  {row.name}
                </button>
                <button
                  type="button"
                  data-testid={`viewer-toolbar-delete-${row.id}`}
                  aria-label={`Delete ${row.name}`}
                  onClick={() => void handleDeleteViewpoint(row.id)}
                  style={{
                    height: 28,
                    minWidth: 28,
                    border: "none",
                    borderRadius: 8,
                    background: "transparent",
                    color: c.danger,
                    fontSize: f.md,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
          {notice && (
            <div
              data-testid="viewer-toolbar-notice"
              style={{ padding: "4px 12px 8px", fontSize: f.sm, color: c.danger }}
            >
              {notice}
            </div>
          )}
        </div>
      )}

      <div style={barRowStyle()}>
        {/* split / segmented control */}
        <div
          role="group"
          aria-label="Measure or save view"
          style={segGroupStyle()}
        >
          <button
            type="button"
            data-testid="viewer-toolbar-measure"
            aria-pressed={state.mode === "measure"}
            aria-haspopup="menu"
            aria-expanded={state.menu === "measure"}
            onClick={handleMeasureToggle}
            style={segButtonStyle(state.mode === "measure")}
          >
            {"\u{1F4CF}"} {measureLabel}
            <span aria-hidden style={{ fontSize: 10, marginLeft: 2 }}>
              {"\u25BE"}
            </span>
          </button>
          <button
            type="button"
            data-testid="viewer-toolbar-save-view-button"
            aria-pressed={state.menu === "save" || state.menu === "views"}
            aria-haspopup="menu"
            aria-expanded={state.menu === "save" || state.menu === "views"}
            onClick={handleSaveViewToggle}
            style={segButtonStyle(state.menu === "save" || state.menu === "views")}
          >
            {"\u{1F4BE}"} Save view
            <span aria-hidden style={{ fontSize: 10, marginLeft: 2 }}>
              {"\u25BE"}
            </span>
          </button>
        </div>

        {entries.length > 0 && (
          <button
            type="button"
            data-testid="viewer-toolbar-list-button"
            aria-pressed={state.menu === "list"}
            aria-haspopup="menu"
            aria-expanded={state.menu === "list"}
            aria-label={`Measurements (${entries.length})`}
            onClick={handleListToggle}
            style={segButtonStyle(state.menu === "list")}
          >
            {"\u2630"} {entries.length}
          </button>
        )}

        {state.mode === "measure" && (
          <>
            {!isMobile && (
            <span
              data-testid="viewer-toolbar-hint"
              style={{ fontSize: f.sm, color: c.text2, whiteSpace: "nowrap" }}
            >
              {measureHint(state.variant)}
            </span>
            )}
            {measureNeedsFinish(state.variant) && (
              <button
                type="button"
                data-testid="viewer-toolbar-finish"
                onClick={handleFinish}
                style={clearButtonStyle("done")}
              >
                {"\u2713"} done
              </button>
            )}
            {formatMeasureReadout(readout) && (
              <span
                data-testid="viewer-toolbar-readout"
                style={readoutChipStyle()}
              >
                {formatMeasureReadout(readout)}
              </span>
            )}
            <button
              type="button"
              data-testid="viewer-toolbar-clear"
              aria-label="Clear measurements"
              onClick={handleClearMeasure}
              style={clearButtonStyle()}
            >
              {"\u232B"} clear
            </button>
          </>
        )}
      </div>
    </FloatingBar>
  );
}
