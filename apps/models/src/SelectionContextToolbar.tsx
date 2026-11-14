// apps/models/src/SelectionContextToolbar.tsx
//
// Wave 47 — right-click selection context toolbar.
//
// Right-click inside the Models 3D viewport opens a floating, frozen
// horizontal pill at the cursor: two split buttons (Element group,
// Category group) whose primary half is the group's default Isolate
// action and whose caret opens a small dropdown (Isolate / Hide), plus
// a "Show all elements" button and a "Create section plane" button.
//
// Maintainer decisions (locked 2026-11-08):
//   - Right-click does NOT select. No pick runs on `contextmenu`; every
//     action acts on the CURRENT selection (`getSelection()` snapshot).
//   - Empty selection → toolbar still opens, but only "Show all
//     elements" is enabled. Element/category groups + section plane are
//     rendered disabled (`aria-disabled`, dimmed, no-op on click).
//   - Floating at cursor, context-menu style. Dismisses on Esc, click /
//     tap outside, pointerdown on the canvas, executing any action, a
//     fresh contextmenu (re-opens at the new position), or window
//     blur/resize. Suppressed entirely while a non-navigation tool is
//     armed (measure / section) or the filter-builder modal is open.
//
// Engine access is strictly through the `IfcViewerHandle` — no raw
// `three` imports, no `@thatopen/*` reach-in. Property-category
// resolution reads the shared `usePropertyIndexStore` inverted index
// (falling back to `getElementData(...)["_IfcClass"]`), matching the
// filter pipeline's `_IfcClass` seam.
//
// Wave 49 — context toolbar polish (two mechanical UI changes):
//   1. A "Remove section planes" icon button after the create button:
//      `handle.clearSectionPlanes()` + `bumpSectionRev()`; enabled only
//      while `handle.getSectionPlaneCount() > 0` (count captured at
//      open time, refreshed on `sectionRev` bumps while open).
//   2. Split buttons restyled to the Google-Docs pattern: no vertical
//      divider, ONE shared rounded light-gray group pill (hover OR menu
//      open), and the dropdown absolutely positioned BELOW the group,
//      aligned to the group's right edge.
//
// Wave 51 (Maintainer correction) — the section-plane control is now ONE
// split button, exactly like the element/category groups:
//
//   - PRIMARY half: "Create section plane" (Cut icon, `handleSectionPlane`,
//     disabled while there is no selection) — same behavior as the
//     standalone button it replaces.
//   - CARET half: opens the section dropdown, whose items are
//     "Create section plane" (Cut) and "Remove section planes" (Xmark,
//     disabled while no section plane exists).
//
// The standalone "Remove section planes" ✕ button is gone — the remove
// action lives INSIDE the section split button. The section group reuses
// the shared `splitGroupStyle` pill + the `hoveredGroup` / `menu` state
// machinery, so `ContextMenu` grew a third variant ("section").

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

// Wave 49 — `iconoir-react@7.11.1` does NOT export `RemoveCut`
// (verified against the installed `dist/index.d.ts`), so the spec's
// documented fallback is used: `Xmark` as the "remove cuts" glyph.
// `Cut` stays reserved for the create-section-plane button.
import {
  Component,
  Cut,
  Eye,
  EyeClosed,
  FrameTool,
  Xmark,
} from "iconoir-react";
import type { IfcViewerHandle } from "@ff/viewer-react";
import { tokens } from "@ff/tasks-react";
import {
  useModelsToolStore,
  usePropertyIndexStore,
  useManualVisibilityStore,
} from "@ff/viewer-tools";

import {
  LONG_PRESS_MOVE_PX,
  LONG_PRESS_MS,
  RIGHT_CLICK_MOVE_PX,
  isRightClick,
  TOOLBAR_SIZE,
  clampPosition,
  computeCategoryClassMap,
  resolveCategoryClass,
  resolveSectionPlaneNormal,
  type SelectionMap,
} from "./contextToolbarState";
import { useViewerToolModeStore } from "./viewerToolModeStore";
import { cameraDirectionFromPose } from "./viewpointStore";

import "./frosted.css";

const { color: c, radius: r, space: s, fontSize: f, font } = tokens;

// Wave 51 — the section-plane control is a third split group, so the
// menu state machine gained a "section" variant.
type ContextMenu = "element" | "category" | "section" | null;

export interface SelectionContextToolbarProps {
  /** Resolve the live viewer handle (may be null before mount). */
  getHandle: () => IfcViewerHandle | null;
  /** The `position: relative` wrapper the listener attaches to. */
  wrapperRef: RefObject<HTMLDivElement | null>;
}

export default function SelectionContextToolbar({
  getHandle,
  wrapperRef,
}: SelectionContextToolbarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [menu, setMenu] = useState<ContextMenu>(null);
  const [hasSelection, setHasSelection] = useState(false);
  // Wave 49 — number of live section planes, captured when the toolbar
  // opens (and refreshed on `sectionRev` bumps while it is open). The
  // "Remove section planes" button is enabled only while > 0.
  const [sectionPlaneCount, setSectionPlaneCount] = useState(0);
  // Wave 49 — which split group the pointer is currently over. The
  // group paints the shared light-gray pill (hover OR menu open).
  const [hoveredGroup, setHoveredGroup] = useState<ContextMenu>(null);

  // Selection snapshot captured at open time (acted on by every action).
  const selectionRef = useRef<SelectionMap>(new Map());
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const getHandleRef = useRef(getHandle);
  getHandleRef.current = getHandle;

  // ── Tool-mode + modal suppression (mirrored into refs for the
  // contextmenu handler, which must see fresh values without re-binding
  // the listener each render). ──────────────────────────────────────
  const viewerTool = useViewerToolModeStore((s) => s.mode);
  const sectionRev = useViewerToolModeStore((s) => s.sectionRev);
  const suppressToolRef = useRef(false);
  suppressToolRef.current = viewerTool !== "navigation";

  const editingPresetId = useModelsToolStore((s) => s.editingPresetId);
  const suppressModalRef = useRef(false);
  suppressModalRef.current = editingPresetId !== null;

  const dismiss = (): void => {
    setOpen(false);
    setMenu(null);
  };

  // ── Wave 54: shared open logic for the desktop contextmenu and the
  //   mobile long-press. Defined per-render (reads fresh state via the
  //   refs above) and mirrored into a ref so the listener effects never
  //   re-bind. Returns false when suppressed (measure armed / modal). ──
  const openAt = (clientX: number, clientY: number): boolean => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return false;
    const h = getHandleRef.current();
    // Suppress the toolbar entirely while a non-navigation tool is
    // armed or a modal surface is open. (`handle.activeTool ===
    // "measure"` is the belt to the store's "measure"/"section"
    // suspenders — the handle is authoritative for the viewer's own
    // measure state, e.g. a level-plan measure future-proof.)
    if (
      h?.activeTool === "measure" ||
      suppressToolRef.current ||
      suppressModalRef.current
    ) {
      return false;
    }
    const rect = wrapper.getBoundingClientRect();
    const clamped = clampPosition({
      clientX,
      clientY,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      size: TOOLBAR_SIZE,
    });
    const sel = h?.getSelection() ?? new Map<string, ReadonlySet<number>>();
    selectionRef.current = sel;
    setHasSelection(sel.size > 0);
    // Wave 49 — snapshot the live section-plane count alongside the
    // selection snapshot so the "Remove section planes" button knows
    // whether it has anything to remove.
    setSectionPlaneCount(h?.getSectionPlaneCount() ?? 0);
    setPos(clamped);
    setMenu(null);
    setOpen(true);
    return true;
  };
  const openAtRef = useRef(openAt);
  openAtRef.current = openAt;

  // ── Wave 54: pending long-press timer (touch path). The contextmenu
  //   handler clears it so Android's native long-press→contextmenu and
  //   our timer never double-open. ──────────────────────────────────
  const longPressTimerRef = useRef<number | null>(null);
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null);

  // ── contextmenu → open the toolbar at the clamped cursor position ─
  //
  // 2026-11-14: only a real right CLICK opens it. A right-drag (camera
  // pan/orbit) or a press-and-hold is navigation, and the browser still
  // fires `contextmenu` for it — on RELEASE on Windows, on PRESS on
  // macOS/Linux. So the right button is tracked from pointerdown:
  //   - contextmenu after the release (Windows): open only if the
  //     press was a click (isRightClick: ≤ 5 px, ≤ 500 ms);
  //   - contextmenu while the button is still down (macOS/Linux):
  //     defer, and decide on pointerup with the same rule;
  //   - contextmenu with no tracked press (keyboard Menu key, tests,
  //     synthetic events): open as before.
  // The native browser menu is suppressed in every case.
  // Listeners are in the CAPTURE phase: the camera controls handle the
  // same pointer events on the canvas below.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let press: { x: number; y: number; t: number; moved: boolean } | null =
      null;
    let deferred: { x: number; y: number } | null = null;

    const clearLongPress = (): void => {
      // Android fires contextmenu at the end of a long-press — the
      // pending timer must not open a second toolbar on top.
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
        longPressStartRef.current = null;
      }
    };

    const wasClick = (x: number, y: number): boolean =>
      press === null ||
      (!press.moved &&
        isRightClick({
          dx: x - press.x,
          dy: y - press.y,
          durationMs: performance.now() - press.t,
        }));

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType === "touch" || e.button !== 2) return;
      press = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      deferred = null;
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!press || press.moved) return;
      if (
        Math.hypot(e.clientX - press.x, e.clientY - press.y) >
        RIGHT_CLICK_MOVE_PX
      ) {
        press.moved = true;
      }
    };

    const onPointerUp = (e: PointerEvent): void => {
      if (e.pointerType === "touch" || e.button !== 2) return;
      const pending = deferred;
      const click = wasClick(e.clientX, e.clientY);
      deferred = null;
      // Windows fires contextmenu right AFTER this pointerup, so keep
      // the press record until then; drop it on the next tick.
      const done = press;
      window.setTimeout(() => {
        if (press === done) press = null;
      }, 0);
      if (pending && click) openAtRef.current(pending.x, pending.y);
    };

    const onContextMenu = (e: MouseEvent): void => {
      // Suppress the browser's native context menu (test: native menu
      // must not appear over the viewport wrapper).
      e.preventDefault();
      clearLongPress();
      if (press !== null && (e.buttons & 2) !== 0) {
        // macOS/Linux: fired on press — wait for the release.
        deferred = { x: e.clientX, y: e.clientY };
        return;
      }
      const click = wasClick(e.clientX, e.clientY);
      press = null;
      if (!click) return;
      openAtRef.current(e.clientX, e.clientY);
    };

    wrapper.addEventListener("pointerdown", onPointerDown, true);
    wrapper.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    wrapper.addEventListener("contextmenu", onContextMenu);
    return () => {
      wrapper.removeEventListener("pointerdown", onPointerDown, true);
      wrapper.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      wrapper.removeEventListener("contextmenu", onContextMenu);
    };
  }, [wrapperRef]);

  // ── Wave 54: mobile long-press → open the toolbar (touch only).
  //   iOS Safari never fires `contextmenu` on canvas elements, so the
  //   phone gets the same tools via a 500ms stationary hold. A hold
  //   that MOVES beyond LONG_PRESS_MOVE_PX is an orbit/pan gesture and
  //   cancels. After a successful open, the next synthetic `click` is
  //   swallowed (capture phase) so the long-press doesn't also select
  //   an element or fire tap-to-create. ────────────────────────────
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const cancel = (): void => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      longPressStartRef.current = null;
    };

    const swallowNextClick = (): void => {
      const onClick = (e: MouseEvent): void => {
        e.stopPropagation();
        e.preventDefault();
        window.removeEventListener("click", onClick, true);
        window.clearTimeout(safety);
      };
      // Safety: drop the swallower if no click arrives (e.g. the user
      // lifts the finger outside the wrapper).
      const safety = window.setTimeout(() => {
        window.removeEventListener("click", onClick, true);
      }, 700);
      window.addEventListener("click", onClick, true);
    };

    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== "touch") return;
      cancel();
      longPressStartRef.current = { x: e.clientX, y: e.clientY };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const start = longPressStartRef.current;
        longPressStartRef.current = null;
        if (!start) return;
        if (openAtRef.current(start.x, start.y)) {
          swallowNextClick();
        }
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent): void => {
      const start = longPressStartRef.current;
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.hypot(dx, dy) > LONG_PRESS_MOVE_PX) cancel();
    };

    const onPointerUp = (): void => cancel();

    wrapper.addEventListener("pointerdown", onPointerDown);
    wrapper.addEventListener("pointermove", onPointerMove);
    wrapper.addEventListener("pointerup", onPointerUp);
    wrapper.addEventListener("pointercancel", onPointerUp);
    return () => {
      cancel();
      wrapper.removeEventListener("pointerdown", onPointerDown);
      wrapper.removeEventListener("pointermove", onPointerMove);
      wrapper.removeEventListener("pointerup", onPointerUp);
      wrapper.removeEventListener("pointercancel", onPointerUp);
    };
  }, [wrapperRef]);

  // ── Selection change → dismiss (simpler of the two accepted options;
  //   the toolbar acts on the snapshot captured at open time). ──────
  useEffect(() => {
    const h = getHandleRef.current();
    if (!h) return;
    // Wave 63: unsubscribe only this listener — `onSelectionChange(null)`
    // cleared every other selection subscriber too.
    const off = h.onSelectionChange(() => {
      setOpen(false);
      setMenu(null);
    });
    return () => off?.();
  }, []);

  // ── Wave 49: re-read the section-plane count when `sectionRev`
  //   changes while the toolbar is open (a cut was added/removed by
  //   another surface) so the clear button's enabled state stays true. ──
  useEffect(() => {
    if (!open) return;
    const h = getHandleRef.current();
    if (!h) return;
    setSectionPlaneCount(h.getSectionPlaneCount());
  }, [open, sectionRev]);

  // ── Dismiss on Esc / outside pointerdown / blur / resize ────────
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismiss();
    };
    const onPointerDown = (e: PointerEvent): void => {
      const el = toolbarRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      dismiss();
    };
    const onBlur = (): void => dismiss();
    const onResize = (): void => dismiss();

    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  // ── Actions ────────────────────────────────────────────────────────
  // Wave 48: hide/isolate/show-all update the durable manual-visibility
  // overlay store — the filter effect (`useModelsToolFilter`) applies the
  // merged final set in the same tick, so manual ops survive a deselect.
  // This component no longer calls `setElementVisibility` directly.
  const handleHideSelected = (): void => {
    dismiss();
    const vis = useManualVisibilityStore.getState();
    for (const [modelId, ids] of selectionRef.current) {
      if (ids.size > 0) vis.hideIds(modelId, ids);
    }
  };

  const handleIsolateSelected = (): void => {
    dismiss();
    const map = new Map<string, Set<number>>();
    for (const [modelId, ids] of selectionRef.current) {
      map.set(modelId, new Set(ids));
    }
    useManualVisibilityStore.getState().isolateTo(map);
  };

  const handleShowAll = (): void => {
    dismiss();
    useManualVisibilityStore.getState().showAll();
  };

  const handleCategory = async (isolate: boolean): Promise<void> => {
    const h = getHandleRef.current();
    dismiss();
    if (!h) return;
    const store = usePropertyIndexStore.getState();

    // [SCT] telemetry breadcrumb — index size per model + the resolution
    // path + the resolved class + op counts. (Sentry is not reachable from
    // apps/models, so a console.info breadcrumb is the shipping consensus.)
    const indexSizes: Record<string, number> = {};
    for (const [modelId, index] of store.indices) {
      indexSizes[modelId] = index.size;
    }
    const resolution = await resolveCategoryClass(
      selectionRef.current,
      store.indices,
      (modelId, expressId) => h.getElementData(modelId, expressId),
    );
    const classMap = resolution.cls
      ? computeCategoryClassMap(resolution.cls, store.indices)
      : new Map<string, Set<number>>();
    const opCount = Array.from(classMap.values()).reduce(
      (n, s) => n + s.size,
      0,
    );
    // eslint-disable-next-line no-console
    console.info("[SCT] category resolution", {
      path: resolution.path,
      cls: resolution.cls,
      indexSize: store.indices.size,
      indexSizes,
      selectedModelId: selectionRef.current.keys().next().value ?? null,
      isolate,
      modelCount: classMap.size,
      opCount,
    });

    if (!resolution.cls) {
      // eslint-disable-next-line no-console
      console.warn("[SelectionContextToolbar] category resolution failed");
      return;
    }

    const vis = useManualVisibilityStore.getState();
    if (isolate) {
      vis.isolateTo(classMap);
    } else {
      for (const [modelId, ids] of classMap) {
        vis.hideIds(modelId, ids);
      }
    }
  };

  const handleHideCategory = (): void => void handleCategory(false);
  const handleIsolateCategory = (): void => void handleCategory(true);

  const handleSectionPlane = async (): Promise<void> => {
    const h = getHandleRef.current();
    dismiss();
    if (!h) return;

    // Prefer the real click point; fall back to the bbox centre.
    const point =
      h.getSelectionWorldPoint() ?? (await h.getSelectionWorldCenter());
    if (!point) {
      // eslint-disable-next-line no-console
      console.warn("[SelectionContextToolbar] no selection world point");
      return;
    }
    // Wave 48: face normal first → bbox-face snap → camera direction.
    const normal = resolveSectionPlaneNormal({
      faceNormal: h.getSelectionWorldNormal(),
      cameraDirection: cameraDirectionFromPose(h.getPose()),
    });
    const ok = h.addSectionPlane(point, normal);
    if (!ok) {
      // Surface the cap through the same warn path the viewer uses.
      // eslint-disable-next-line no-console
      console.warn("[SelectionContextToolbar] section plane cap reached");
      return;
    }
    // Keep the bottom toolbar's "n/8 cuts" readout in sync via the
    // shared tool-mode store (ViewerToolbar refreshes on sectionRev).
    useViewerToolModeStore.getState().bumpSectionRev();
  };

  // Wave 49 — "Remove section planes": clears every section plane
  // (the horizontal floor clip is untouched — that is the engine's
  // job) and bumps `sectionRev` so the bottom toolbar's "n/8 cuts"
  // counter refreshes, exactly like the create action above.
  const handleClearSectionPlanes = (): void => {
    const h = getHandleRef.current();
    if (h) {
      h.clearSectionPlanes();
      useViewerToolModeStore.getState().bumpSectionRev();
    }
    dismiss();
  };

  // ── Split-button dropdown ────────────────────────────────────────
  // Wave 49 — the dropdown now renders INSIDE the open split group so
  // it can anchor to that group's right edge (Google-Docs pattern)
  // instead of sitting as a sibling under the toolbar row.
  const renderSplitMenu = (which: Exclude<ContextMenu, null>): JSX.Element => {
    const menuLabel =
      which === "element"
        ? "Element tools"
        : which === "category"
          ? "Category tools"
          : "Section tools";
    return (
      <div
        data-testid="selection-context-toolbar-menu"
        role="menu"
        aria-label={menuLabel}
        className="ff-frosted"
        style={menuStyle()}
      >
        {which === "element" ? (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="sct-isolate-selected"
              onClick={() => void handleIsolateSelected()}
              style={menuRowStyle(false)}
            >
              <FrameTool width={15} height={15} strokeWidth={1.75} />
              Isolate selected element
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="sct-hide-selected"
              onClick={handleHideSelected}
              style={menuRowStyle(false)}
            >
              <EyeClosed width={15} height={15} strokeWidth={1.75} />
              Hide selected element
            </button>
          </>
        ) : which === "category" ? (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="sct-isolate-category"
              onClick={() => void handleIsolateCategory()}
              style={menuRowStyle(false)}
            >
              <Component width={15} height={15} strokeWidth={1.75} />
              Isolate selected category
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="sct-hide-category"
              onClick={() => void handleHideCategory()}
              style={menuRowStyle(false)}
            >
              <EyeClosed width={15} height={15} strokeWidth={1.75} />
              Hide selected category
            </button>
          </>
        ) : (
          <>
            {/* Wave 51 — "Create section plane" is ALSO reachable from
                the dropdown; same behavior as the primary half (and
                disabled without a selection, like the primary). */}
            <button
              type="button"
              role="menuitem"
              aria-label="Create section plane"
              aria-disabled={!hasSelection || undefined}
              data-testid="sct-create-section"
              onClick={() => {
                if (hasSelection) void handleSectionPlane();
              }}
              style={menuRowStyle(!hasSelection)}
            >
              <Cut width={15} height={15} strokeWidth={1.75} />
              Create section plane
            </button>
            {/* Wave 51 — "Remove section planes" moved INTO this
                dropdown (the standalone ✕ button is gone). Enabled
                only while section planes exist. */}
            <button
              type="button"
              role="menuitem"
              aria-label="Remove section planes"
              aria-disabled={sectionPlaneCount <= 0 || undefined}
              data-testid="sct-clear-section"
              onClick={() => {
                if (sectionPlaneCount > 0) handleClearSectionPlanes();
              }}
              style={menuRowStyle(sectionPlaneCount <= 0)}
            >
              <Xmark width={15} height={15} strokeWidth={1.75} />
              Remove section planes
            </button>
          </>
        )}
      </div>
    );
  };

  if (!open) return (<></>);

  return (
    <div
      ref={toolbarRef}
      data-testid="selection-context-toolbar"
      role="toolbar"
      aria-label="Selection tools"
      className="ff-frosted"
      style={{
        position: "absolute",
        left: pos.x,
        top: pos.y,
        zIndex: 30,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: 4,
        borderRadius: 14,
        fontFamily: font,
        // Wave 49 — the split-button dropdown is absolutely positioned
        // INSIDE a group and must not be clipped by the toolbar shell.
        overflow: "visible",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: s.s2 }}>
        {/* ── Element group (split: Isolate ▾) ─────────────────── */}
        <div
          role="group"
          aria-label="Element tools"
          onMouseEnter={() => setHoveredGroup("element")}
          onMouseLeave={() =>
            setHoveredGroup((g) => (g === "element" ? null : g))
          }
          style={splitGroupStyle(menu === "element", hoveredGroup === "element")}
        >
          <button
            type="button"
            aria-label="Isolate selected element"
            aria-disabled={!hasSelection || undefined}
            data-testid="sct-element-split"
            onClick={() => {
              if (hasSelection) void handleIsolateSelected();
            }}
            style={primaryButtonStyle(!hasSelection)}
          >
            <FrameTool width={16} height={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="More element tools"
            aria-haspopup="menu"
            aria-expanded={menu === "element"}
            aria-disabled={!hasSelection || undefined}
            data-testid="sct-element-caret"
            onClick={() => {
              if (hasSelection) setMenu((m) => (m === "element" ? null : "element"));
            }}
            style={caretButtonStyle(!hasSelection)}
          >
            <span aria-hidden style={{ fontSize: 9 }}>{"\u25BE"}</span>
          </button>
          {menu === "element" ? renderSplitMenu("element") : null}
        </div>

        {/* ── Category group (split: Isolate ▾) ────────────────── */}
        <div
          role="group"
          aria-label="Category tools"
          onMouseEnter={() => setHoveredGroup("category")}
          onMouseLeave={() =>
            setHoveredGroup((g) => (g === "category" ? null : g))
          }
          style={splitGroupStyle(menu === "category", hoveredGroup === "category")}
        >
          <button
            type="button"
            aria-label="Isolate selected category"
            aria-disabled={!hasSelection || undefined}
            data-testid="sct-category-split"
            onClick={() => {
              if (hasSelection) void handleIsolateCategory();
            }}
            style={primaryButtonStyle(!hasSelection)}
          >
            <Component width={16} height={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="More category tools"
            aria-haspopup="menu"
            aria-expanded={menu === "category"}
            aria-disabled={!hasSelection || undefined}
            data-testid="sct-category-caret"
            onClick={() => {
              if (hasSelection) setMenu((m) => (m === "category" ? null : "category"));
            }}
            style={caretButtonStyle(!hasSelection)}
          >
            <span aria-hidden style={{ fontSize: 9 }}>{"\u25BE"}</span>
          </button>
          {menu === "category" ? renderSplitMenu("category") : null}
        </div>

        {/* ── Show all elements (always enabled) ───────────────── */}
        <button
          type="button"
          aria-label="Show all elements"
          data-testid="sct-show-all"
          onClick={() => void handleShowAll()}
          style={iconButtonStyle(false)}
        >
          <Eye width={16} height={16} strokeWidth={1.75} />
        </button>

        {/* ── Section group (split: Create section plane ▾) ───── */}
        {/* Wave 51 — the create action and the "remove section
            planes" action now live in ONE split button: the primary
            half creates the plane (disabled without a selection),
            the caret opens the dropdown that holds both actions. */}
        <div
          role="group"
          aria-label="Section tools"
          onMouseEnter={() => setHoveredGroup("section")}
          onMouseLeave={() =>
            setHoveredGroup((g) => (g === "section" ? null : g))
          }
          style={splitGroupStyle(menu === "section", hoveredGroup === "section")}
        >
          <button
            type="button"
            aria-label="Create section plane"
            aria-disabled={!hasSelection || undefined}
            data-testid="sct-section-plane"
            onClick={() => {
              if (hasSelection) void handleSectionPlane();
            }}
            style={primaryButtonStyle(!hasSelection)}
          >
            <Cut width={16} height={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="More section tools"
            aria-haspopup="menu"
            aria-expanded={menu === "section"}
            data-testid="sct-section-caret"
            onClick={() => setMenu((m) => (m === "section" ? null : "section"))}
            style={caretButtonStyle(false)}
          >
            <span aria-hidden style={{ fontSize: 9 }}>{"\u25BE"}</span>
          </button>
          {menu === "section" ? renderSplitMenu("section") : null}
        </div>
      </div>
    </div>
  );
}

// Wave 49 — shared Google-Docs-style split group: ONE rounded
// light-gray pill behind the primary half + the caret (no divider
// line), painted on hover OR while the group's menu is open. The
// container is the positioning anchor for the dropdown.
function splitGroupStyle(expanded: boolean, hovered: boolean): CSSProperties {
  return {
    position: "relative",
    display: "flex",
    flexShrink: 0,
    borderRadius: 10,
    background: expanded || hovered ? c.focusRingTint : "transparent",
    transition: "background 120ms ease",
  };
}

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    width: 40,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: "10px 0 0 10px",
    background: "transparent",
    color: disabled ? c.muted : c.text,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 120ms ease, color 120ms ease",
  };
}

// Wave 49 — the caret no longer draws a vertical divider
// (`borderLeft` removed); the shared group background provides the
// visual separation between the two halves.
function caretButtonStyle(disabled: boolean): CSSProperties {
  return {
    width: 18,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: "0 10px 10px 0",
    background: "transparent",
    color: disabled ? c.muted : c.text2,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 120ms ease, color 120ms ease",
  };
}

function iconButtonStyle(disabled: boolean): CSSProperties {
  return {
    width: 40,
    height: 40,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: "none",
    borderRadius: 10,
    background: "transparent",
    color: disabled ? c.muted : c.text,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 120ms ease, color 120ms ease",
  };
}

// Wave 49 — the dropdown is positioned absolutely BELOW its split
// group and aligned to that group's RIGHT edge (like the reference).
function menuStyle(): CSSProperties {
  return {
    position: "absolute",
    top: "calc(100% + 6px)",
    right: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 200,
    borderRadius: 12,
    padding: 6,
    fontFamily: font,
  };
}

// Wave 51 — the parameter is now the DISABLED flag: a disabled row
// (e.g. "Remove section planes" while no cut exists) is dimmed and
// behaves as a no-op.
function menuRowStyle(disabled = false): CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 12px",
    borderRadius: r.md,
    border: "none",
    background: "transparent",
    color: disabled ? c.muted : c.text,
    opacity: disabled ? 0.55 : 1,
    fontSize: f.md,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}