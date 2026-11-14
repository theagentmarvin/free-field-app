// src/calibration/MappingView.tsx
//
// Split-view calibration wizard. Mounts in place of the regular
// PdfOverlay / IfcViewer when useViewerStore.calibrationFlow !==
// null. The layout is locked 50/50: top = PDF, bottom = 3D, with
// a status bar across the very top showing the current step +
// Cancel / Save buttons. A full-bleed SVG overlay over the
// bottom half draws the 3D line preview between the two world
// picks.
//
// Lifecycle:
//   - mount: subscribe to the calibration flow. Wire the PDF
//     click handler to dispatch SET_PDF_PICK. Wire the 3D
//     container click handler to dispatch SET_WORLD_PICK after
//     calling `ifcViewerHandle.pickWorldPoint()`.
//   - unmount: cancel the animation frame and clear the SVG
//     overlay state. The 3D world is owned by the IfcViewer
//     (parent component) so the destroy is its responsibility.
//
// StrictMode-safe: `disposedRef` pattern matches <PdfOverlay>
// and <IfcViewer>. On every mount we reset it to false; on every
// cleanup we check it before mutating live state.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import { useRequiredProjectId } from "@ff/auth";
import { useViewerHandle } from "@ff/viewer-react";
import { PdfOverlay, type PdfOverlayHandle } from "@ff/viewer-react";
import { useViewerStore } from "@store/useViewerStore";
import { STEP_LABELS, type CalibrationStep } from "@calibration/state";

import { computeSimilarityTransform } from "@ff/data/calibration/similarity";
import { db } from "@ff/data/db/database";
import type { CalibrationRecord } from "@ff/types";
import {
  createCalibration,
  getCalibrationForPdfAndStorey,
  updateCalibration,
} from "@ff/data/db/tables/calibrations";
import { getPdfFile } from "@ff/data/db/tables/pdfFiles";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";

// Layout constants. 50/50 split with a 1px divider, status bar
// at the top of the wizard (NOT the very top of the panel — the
// panel already has the app header above it).
const SPLIT_PERCENT = 50;
const STATUS_BAR_HEIGHT = 40;
const DIVIDER_HEIGHT = 1;

// 2026-06-03 (Task 15): the wrapper no longer has a background
// color. It used to be `var(--ff-bg-panel)` but that painted
// over the parent's <IfcViewer> sitting behind the wizard —
// the 3D pane is a transparent child, so the user saw the
// panel color instead of the 3D view. Each visible child
// (status bar, PDF pane) carries its own background; the 3D
// pane stays transparent so the IfcViewer shows through.
const wrapperStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  // No background — see comment above.
  overflow: "hidden",
};

// 2026-06-03 (Task 15 follow-up): the status bar opts back
// into `pointer-events: auto` because the absolute wrapper
// around the MappingView is `pointer-events: none` (so the
// IfcViewer's camera can still receive mouse events through
// the 3D pane). Without this, the Cancel and Save buttons
// would be unclickable.
const statusBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: STATUS_BAR_HEIGHT,
  padding: "0 12px",
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flexShrink: 0,
  pointerEvents: "auto",
};

const statusLabelStyle: CSSProperties = {
  flex: 1,
  fontSize: 13,
  fontWeight: 500,
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

const buttonStyle: CSSProperties = {
  height: 28,
  padding: "0 12px",
  borderRadius: 4,
  border: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "var(--ff-font-stack)",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "var(--ff-blue-active)",
  color: "#fff",
  border: "1px solid var(--ff-blue-active)",
  opacity: 1,
};

const disabledButtonStyle: CSSProperties = {
  ...buttonStyle,
  opacity: 0.4,
  cursor: "not-allowed",
};

const splitBodyStyle = (): CSSProperties => ({
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
});

const splitPaneStyle = (heightPct: number): CSSProperties => ({
  width: "100%",
  height: `${heightPct}%`,
  position: "relative",
  minHeight: 0,
  overflow: "hidden",
  // 2026-06-03 (Task 15 follow-up): PDF pane defaults to
  // `pointer-events: auto` so the PdfOverlay inside receives
  // click events for picks. The 3D pane override at the call
  // site (`splitPaneStyle(100 - SPLIT_PERCENT)` plus
  // `pointerEvents: ...`) takes precedence and toggles
  // between `auto` (during PICK_WORLD_* steps) and `none`
  // (otherwise).
  pointerEvents: "auto",
});

const dividerStyle: CSSProperties = {
  width: "100%",
  height: DIVIDER_HEIGHT,
  background: "var(--ff-border)",
  flexShrink: 0,
};

// Marker geometry. The wizard draws 4 markers (one per pick) and
// 1 line (between worldA and worldB) when both world picks are
// set. PDF markers live in the PDF half; 3D markers live in the
// SVG overlay.
// Perf (3D line preview loop): a projected pick that moved by no more
// than this many CSS px is not re-committed to state.
const SCREEN_POINT_EPSILON = 0.5;

type ScreenPoint = { x: number; y: number };

function sameScreenPoint(
  prev: ScreenPoint | null | undefined,
  next: ScreenPoint | null,
): boolean {
  if (prev === undefined) return false;
  if (prev === null || next === null) return prev === next;
  return (
    Math.abs(prev.x - next.x) <= SCREEN_POINT_EPSILON &&
    Math.abs(prev.y - next.y) <= SCREEN_POINT_EPSILON
  );
}

const MARKER_RADIUS = 6;
const WORLD_MARKER_COLOR = "#16a34a";
const LINE_COLOR = "#facc15";
const LINE_WIDTH = 2;

// Task 13: PDF pick marker colors. Picked in red (matches the
// delete-button red used elsewhere) so the user can see at a
// glance "this is a pick intent, not part of the plan". The
// line between the two PDF picks uses the same yellow as the 3D
// line so the user knows "these two are connected".
const PDF_MARKER_COLOR = "#dc2626";
const PDF_LINE_COLOR = "#facc15";
const PDF_LINE_WIDTH = 2;

// Wave 63: two picks closer than this make the similarity transform
// degenerate (scale explodes, rotation is noise). PDF coords are PDF
// points (1/72 in); world coords are model metres.
export const MIN_PDF_PICK_DISTANCE = 10;
export const MIN_WORLD_PICK_DISTANCE = 0.25;

/** Why the four picks can't be saved, or null when they can. */
export function pickDistanceError(flow: {
  pdfA: { x: number; y: number } | null;
  pdfB: { x: number; y: number } | null;
  worldA: { x: number; z: number } | null;
  worldB: { x: number; z: number } | null;
}): string | null {
  if (flow.pdfA && flow.pdfB) {
    const d = Math.hypot(flow.pdfB.x - flow.pdfA.x, flow.pdfB.y - flow.pdfA.y);
    if (d < MIN_PDF_PICK_DISTANCE) {
      return "PDF points A and B are too close together — click a marker to re-pick one farther away.";
    }
  }
  if (flow.worldA && flow.worldB) {
    const d = Math.hypot(flow.worldB.x - flow.worldA.x, flow.worldB.z - flow.worldA.z);
    if (d < MIN_WORLD_PICK_DISTANCE) {
      return "3D points A and B are too close together — click a marker to re-pick one farther away.";
    }
  }
  return null;
}

const errorTextStyle: CSSProperties = {
  fontSize: 12,
  color: "var(--ff-danger, #dc2626)",
  fontFamily: "var(--ff-font-stack)",
  maxWidth: 360,
};

export default function MappingView(): React.ReactNode {
  // Subscribe to the flow. We use a single selector for the
  // whole flow object so re-renders fire on any change. The
  // store also exposes the dispatchers.
  const flow = useViewerStore((s) => s.calibrationFlow);
  const dispatch = useViewerStore((s) => s.dispatchCalibrationAction);
  const cancel = useViewerStore((s) => s.cancelCalibration);

  // Task 15: use the PARENT'S <IfcViewer> handle (provided by
  // ViewerHandleContext). The MappingView no longer mounts its
  // own <IfcViewer> — the parent's instance stays mounted
  // across the wizard open/close so the level view + camera
  // position + all models are preserved. This is the single
  // most important refactor of Task 15.
  const viewerRef = useViewerHandle();

  // StrictMode-safe. Reset on every mount.
  const disposedRef = useRef(false);

  // 3D line preview state. The two screen-space points are
  // recomputed every animation frame from the world picks.
  // Task 15: the SVG using these is portaled into the parent's
  // IfcViewer container (via `viewerRef.current.getContainer()`)
  // so the coords align with the canvas's CSS pixel system.
  const [worldScreenA, setWorldScreenA] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [worldScreenB, setWorldScreenB] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Task 15b: the marker SVG is portaled into the PDF viewer's
  // annotation layer (a sibling of the canvas inside
  // `.pv-zoom-transform`). Because the layer shares the parent's
  // CSS transform, the markers track the canvas for free — no
  // rAF polling, no getBoundingClientRect re-projection. We only
  // need the current `renderScale` to project page coords into
  // canvas-local CSS pixels.
  const [renderScale, setRenderScale] = useState(1);

  // The annotation layer is the DOM node returned by
  // `pdfOverlayHandle.getAnnotationLayer()`. The component reads
  // the ref on every `flow` change and re-evaluates the portal
  // container on the next render. If the viewer is replaced
  // (HMR, new PDF version), the new layer is picked up
  // automatically.
  const [annotationLayer, setAnnotationLayer] = useState<HTMLDivElement | null>(null);

  // Refs to the PDF pane (kept for layout / click capture) and
  // the PdfOverlay's imperative handle.
  const pdfPaneRef = useRef<HTMLDivElement | null>(null);
  const pdfOverlayHandleRef = useRef<PdfOverlayHandle | null>(null);

  // Task 15: ref to the transparent 3D pane. Clicks on this
  // pane are captured by the wizard during PICK_WORLD_* steps
  // (when pointer-events: auto); otherwise clicks pass through
  // to the parent's <IfcViewer> underneath so the user can
  // rotate/pan/zoom the camera.
  const worldPaneRef = useRef<HTMLDivElement | null>(null);

  // The wizard pulls the active PDF version (the latest one
  // for the calibration flow's pdfFileId) from Dexie. The
  // PdfOverlay is keyed on it. We don't need the building id
  // anymore — the parent <ViewerPanel> owns the <IfcViewer>
  // (which has the building id), and the wizard reads it via
  // the ViewerHandleContext. Task 15.
  const [pdfVersionId, setPdfVersionId] = useState<string | null>(null);
  // The project id is needed for `createCalibration`. Other modules
  // read calibrations by `[projectId+pdfFileId]` with useProjectId(),
  // so the write uses the same active project. The wizard renders only
  // behind the shell's project gate; with no project this throws
  // NoActiveProjectError (caught by the module error boundary) instead
  // of writing under a made-up id (wave 66).
  const projectId = useRequiredProjectId();

  // Save state: a double click must not write twice, and a failed
  // write is shown inline instead of being swallowed.
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // A new pick (or re-pick) clears the previous save error.
  useEffect(() => {
    setSaveError(null);
  }, [flow?.pdfA, flow?.pdfB, flow?.worldA, flow?.worldB]);

  // Resolve the PDF's latest version when the flow changes.
  // If the flow is null the MappingView is hidden and this
  // effect short-circuits.
  useEffect(() => {
    disposedRef.current = false;
    if (!flow) {
      setPdfVersionId(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const file = await getPdfFile(flow.pdfFileId);
      if (cancelled) return;
      if (!file) {
        setPdfVersionId(null);
        return;
      }
      // We need the LATEST version of the PDF — same one the
      // sidebar would open if the user clicked the file row.
      const { getLatestPdfVersion } = await import(
        "@ff/data/db/tables/pdfVersions"
      );
      const latest = await getLatestPdfVersion(flow.pdfFileId);
      if (cancelled) return;
      setPdfVersionId(latest?.id ?? null);
    })();
    return () => {
      cancelled = true;
      // Mark disposed on real unmount (not the strict-mode
      // double-unmount) so we can short-circuit late state
      // updates in the IIFE.
      if (!disposedRef.current) {
        disposedRef.current = true;
      }
    };
  }, [flow]);

  // Save handler. The user clicks Save in REVIEW → we look up
  // the current project, compute the similarity transform, and write the
  // row. If a calibration already exists for (pdfFileId,
  // storeyName) we update it instead of creating a new one
  // (upsert by wizard logic).
  const handleSave = async (): Promise<void> => {
    if (!flow) return;
    if (savingRef.current) return;
    if (
      flow.step !== "REVIEW" ||
      !flow.pdfA ||
      !flow.pdfB ||
      !flow.worldA ||
      !flow.worldB
    ) {
      return;
    }
    const distanceError = pickDistanceError(flow);
    if (distanceError) {
      setSaveError(distanceError);
      return;
    }
    const { pdfA, pdfB, worldA, worldB, pdfFileId, storeyName } = flow;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const params = computeSimilarityTransform(pdfA, pdfB, worldA, worldB);
      const pairs: CalibrationRecord["pointPairs"] = [
        { pdfX: pdfA.x, pdfY: pdfA.y, worldX: worldA.x, worldZ: worldA.z },
        { pdfX: pdfB.x, pdfY: pdfB.y, worldX: worldB.x, worldZ: worldB.z },
      ];
      // One rw transaction: the lookup and the write can't interleave
      // with another save (no duplicate rows for the same pdf+storey).
      await db.transaction("rw", db.calibrations, async () => {
        const existing = await getCalibrationForPdfAndStorey(pdfFileId, storeyName);
        if (existing) {
          await updateCalibration(existing.id, {
            pointPairs: pairs,
            transformParams: params,
            confidence: 1,
          });
        } else {
          await createCalibration({
            projectId,
            pdfFileId,
            storeyName,
            pointPairs: pairs,
            transformParams: params,
            confidence: 1,
          });
        }
      });
    } catch (err) {
      setSaveError(
        `Couldn't save the calibration: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
    dispatch({ type: "MARK_SAVED" });
    // Close the wizard so the user is back in the 3D view.
    // The reducer state already flipped to "SAVED" above, but
    // keeping the flow open would leave the user staring at a
    // frozen split view with no next action. Setting the flow
    // to null unmounts <MappingView> and reveals the
    // <PdfOverlay>/<IfcViewer> pair underneath.
    cancel();
  };

  // ─── 3D line preview: animation frame loop ──────────────────────
  // We use rAF to re-project the world picks on every camera
  // change. The loop starts when both worldA and worldB are
  // set; it stops when either is cleared or the flow is null.
  //
  // Task 15: the handle is the parent's <IfcViewer> (via
  // useViewerHandle), so the projection matches what the user
  // sees on the canvas. The SVG that consumes these screen
  // coords is portaled into the IfcViewer's container.
  useEffect(() => {
    if (!flow) {
      setWorldScreenA(null);
      setWorldScreenB(null);
      return;
    }
    // Run the rAF loop as soon as AT LEAST ONE pick exists.
    // The earlier guard `!worldA || !worldB` made point A
    // invisible during PICK_WORLD_B (after the first click,
    // before the second) — the loop never started so the
    // marker SVG had no screen coords to render.
    if (!flow.worldA && !flow.worldB) {
      setWorldScreenA(null);
      setWorldScreenB(null);
      return;
    }
    let rafId: number | null = null;
    let alive = true;
    // Perf: only re-project when the viewport revision (camera
    // matrices + canvas size) changed, and only setState when a
    // projected point actually moved (> SCREEN_POINT_EPSILON px) or
    // appeared/disappeared — a still camera costs zero renders. The
    // first tick after (re)starting the loop always projects; the
    // picks themselves are effect deps (`flow`), so a pick change
    // restarts the loop.
    let lastRevision: number | null = null;
    let primed = false;
    // `undefined` = not committed yet in this loop ⇒ the first
    // projection always lands (clears a stale point from a previous
    // flow, e.g. after RE_PICK).
    let lastA: ScreenPoint | null | undefined = undefined;
    let lastB: ScreenPoint | null | undefined = undefined;
    const tick = (): void => {
      if (!alive) return;
      // Read the handle fresh on every tick so we always use
      // the latest viewer (the ref's `current` is mutated by
      // the IfcViewer's useImperativeHandle, which can happen
      // after this effect's first run).
      const handle = viewerRef.current;
      if (handle) {
        // `undefined` = a host without the token ⇒ always dirty.
        const revision = handle.getViewportRevision?.();
        const dirty =
          !primed || revision === undefined || revision !== lastRevision;
        if (dirty) {
          primed = true;
          lastRevision = revision ?? null;
          // Project each pick independently. If a pick was
          // cleared (e.g. after RE_PICK) clear its screen state
          // so the marker disappears, instead of leaving the
          // old position visible.
          const a = flow.worldA
            ? handle.worldToScreen({ x: flow.worldA.x, y: 0, z: flow.worldA.z })
            : null;
          if (!sameScreenPoint(lastA, a)) {
            lastA = a;
            setWorldScreenA(a);
          }
          const b = flow.worldB
            ? handle.worldToScreen({ x: flow.worldB.x, y: 0, z: flow.worldB.z })
            : null;
          if (!sameScreenPoint(lastB, b)) {
            lastB = b;
            setWorldScreenB(b);
          }
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
    // viewerRef is intentionally omitted from the deps. The
    // ref object is stable for the lifetime of the
    // ViewerHandleProvider; we read `viewerRef.current` on
    // every tick, so a stale closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  // ─── 3D wheel forwarding ─────────────────────────────────────
  // The 3D pane is `pointer-events: auto` during PICK_WORLD_*
  // so the wizard can capture clicks. As a side effect, the
  // pane swallows wheel events before they reach the canvas
  // where OBC.MouseNavigation listens — so zoom breaks for
  // the entire pick phase and only comes back when the step
  // advances to REVIEW (where the pane flips back to
  // `pointer-events: none`).
  //
  // The IfcViewer handle's `zoom(deltaY, clientX, clientY,
  // deltaMode)` is a drop-in replacement for a native wheel
  // event on the canvas: it does the same delta normalization
  // (pixel vs line mode, Mac vs not) and the same NDC
  // cursor-pivot math that `camera-controls` does in its own
  // `onMouseWheel`. So a forwarded wheel feels identical to a
  // native one, including sensitivity and zoom-around-cursor.
  //
  // We attach via `addEventListener` with `{ passive: false }`
  // so `preventDefault()` actually stops the page from
  // scrolling under the cursor — React 17+ attaches `onWheel`
  // passively by default.
  useEffect(() => {
    if (!flow) return;
    if (flow.step !== "PICK_WORLD_A" && flow.step !== "PICK_WORLD_B") {
      return;
    }
    const pane = worldPaneRef.current;
    if (!pane) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const handle = viewerRef.current;
      if (!handle) return;
      handle.zoom(e.deltaY, e.clientX, e.clientY, e.deltaMode);
    };
    pane.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      pane.removeEventListener("wheel", onWheel);
    };
    // viewerRef is intentionally omitted from the deps — see
    // the rAF effect above for the same rationale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  // ─── Task 15b: scale-change subscription + annotation layer resolution ─
  // The PdfViewer is created asynchronously inside <PdfOverlay>.
  // The handle's setOnScaleChange and getAnnotationLayer delegate
  // to viewerRef.current which is null until the async load
  // completes. A plain useEffect gated on [flow] fires too early.
  // We poll until the annotation layer is available, then wait
  // for the viewer's onReady signal (render settled, transform
  // stable) before mounting the portal.
  //
  // CRITICAL: we resolve the annotation layer from the LIVE DOM
  // via querySelector, NOT from handle.getAnnotationLayer().
  // The handle may return a stale DOM node (StrictMode
  // double-mount, HMR class-instance preservation) that exists
  // in a detached subtree — the portal renders into it but the
  // SVG is invisible. The data-attribute selector always finds
  // the DOM node that is actually in the visible tree.
  useEffect(() => {
    if (!flow) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let unsubScale: (() => void) | null = null;

    intervalId = setInterval(() => {
      const handle = pdfOverlayHandleRef.current;
      if (!handle) return;

      // Find the LIVE annotation layer in the document.
      const layer = document.querySelector(
        '[data-pv-annotation-layer="true"]',
      ) as HTMLDivElement | null;
      if (!layer) return;

      // DOM is live. Stop polling.
      clearInterval(intervalId!);
      intervalId = null;

      // Wait for the render to settle before mounting.
      handle.onReady(() => {
        // Re-query in case the DOM was replaced between poll
        // tick and onReady (paranoid, costs nothing).
        const fresh = document.querySelector(
          '[data-pv-annotation-layer="true"]',
        ) as HTMLDivElement | null;
        if (fresh) setAnnotationLayer(fresh);
        unsubScale = handle.setOnScaleChange((e) =>
          setRenderScale(e.renderScale),
        );
      });
    }, 100);

    return () => {
      if (intervalId !== null) clearInterval(intervalId);
      unsubScale?.();
    };
  }, [flow]);

  // ─── Click handlers ─────────────────────────────────────────────
  // PDF click: forward to onPdfClick. The PdfOverlay's
  // captureClicks prop gates its own click handler, so when
  // captureClicks is false the click is a no-op (the user is
  // either in a non-pick step or the wizard isn't
  // interactive).
  const handlePdfClick = (coords: { x: number; y: number }): void => {
    if (!flow) return;
    if (flow.step === "PICK_PDF_A" || flow.step === "PICK_PDF_B") {
      dispatch({ type: "SET_PDF_PICK", point: coords });
    }
  };

  // 3D click: cast a ray from the camera through the click
  // point. We pass the actual click coords (e.clientX/Y) to
  // `pickWorldPoint`, which converts to NDC and forwards to
  // OBC's `castRay({ position })`. Without this override,
  // OBC's `Mouse` class would supply its own position — and
  // the Mouse class only listens for `pointermove` on the
  // CANVAS, which the wizard's 3D pane (`pointer-events: auto`)
  // shadows. The Mouse position would be stale (often the
  // last spot the cursor was before the wizard opened, e.g.
  // the Cancel button), and every pick would land there.
  //
  // Task 15: the handle is the PARENT'S <IfcViewer> (from
  // ViewerHandleContext), not a local instance. The raycast
  // fires against the parent's camera, which is the same
  // camera the user is looking at through the transparent
  // 3D pane.
  const handleWorldClick = async (
    e: ReactMouseEvent<HTMLDivElement>,
  ): Promise<void> => {
    if (!flow) return;
    if (flow.step !== "PICK_WORLD_A" && flow.step !== "PICK_WORLD_B") return;
    const handle = viewerRef.current;
    if (!handle) return;
    const point = await handle.pickWorldPoint(e.clientX, e.clientY);
    if (!point) {
      // Empty-space click. The spec says "raycast only" — no
      // picking plane. We surface a no-op; the wizard UI
      // could add a toast here in a follow-up.
      return;
    }
    dispatch({ type: "SET_WORLD_PICK", point: { x: point.x, z: point.z } });
  };

  // ─── Render ────────────────────────────────────────────────────
  if (!flow) {
    // The parent (<ViewerPanel>) shouldn't render us when
    // the flow is null, but we guard anyway.
    return null;
  }

  const step: CalibrationStep = flow.step;
  const label = STEP_LABELS[step];
  const isPdfPickStep =
    step === "PICK_PDF_A" || step === "PICK_PDF_B";
  const isWorldPickStep =
    step === "PICK_WORLD_A" || step === "PICK_WORLD_B";
  const isReview = step === "REVIEW";
  const isSaved = step === "SAVED";
  const distanceError = isReview ? pickDistanceError(flow) : null;
  const canSave = isReview && !saving && distanceError === null;
  const inlineError = saveError ?? distanceError;

  return (
    <div
      style={wrapperStyle}
      data-testid="mapping-view"
      data-step={step}
      data-pdf-file-id={flow.pdfFileId}
      data-storey-name={flow.storeyName}
    >
      <div style={statusBarStyle} data-testid="mapping-view-status">
        <span style={statusLabelStyle} data-testid="mapping-view-step-label">
          {label}
        </span>
        <button
          type="button"
          data-testid="mapping-view-cancel"
          onClick={cancel}
          style={buttonStyle}
        >
          Cancel
        </button>
        {inlineError ? (
          <span role="alert" style={errorTextStyle} data-testid="mapping-view-error">
            {inlineError}
          </span>
        ) : null}
        <button
          type="button"
          data-testid="mapping-view-save"
          onClick={handleSave}
          disabled={!canSave}
          aria-busy={saving}
          style={canSave ? primaryButtonStyle : disabledButtonStyle}
        >
          {isSaved ? "Saved" : saving ? "Saving…" : "Save"}
        </button>
      </div>

      <div style={splitBodyStyle()}>
        <div ref={pdfPaneRef} style={splitPaneStyle(SPLIT_PERCENT)} data-testid="mapping-view-pdf-pane">
          {pdfVersionId ? (
            <>
              <PdfOverlay
                ref={pdfOverlayHandleRef}
                pdfVersionId={pdfVersionId}
                getPdfVersion={getPdfVersion}
                getPdfBlob={getPdfBlob}
                captureClicks={isPdfPickStep}
                onPdfClick={handlePdfClick}
              />
              {/* Task 15b: PDF pick marker overlay. Portaled into
                  the PDF viewer's annotation layer — a sibling
                  of the canvas inside `.pv-zoom-transform` — so
                  it inherits the parent's CSS transform. Markers
                  are placed at canvas-local CSS pixels (= page
                  coords × renderScale) and the parent's
                  transform carries them to the visual position
                  for free. No rAF polling, no
                  getBoundingClientRect re-projection.

                  `vector-effect="non-scaling-size"` keeps the
                  marker visual size constant during zoom;
                  `vector-effect="non-scaling-stroke"` keeps the
                  line stroke width constant. */}
              {annotationLayer && (flow.pdfA || flow.pdfB)
                ? createPortal(
                    <svg
                      data-testid="pdf-pick-overlay"
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        // Explicit CSS px from the annotation layer's
                        // inline style (set in JS). Using width="100%"
                        // resolves against the containing block
                        // (.pv-zoom-transform) which has 0 intrinsic
                        // width (all children are position:absolute).
                        width: annotationLayer.style.width || "100%",
                        height: annotationLayer.style.height || "100%",
                        pointerEvents: "none",
                        overflow: "visible",
                      }}
                    >
                      {flow.pdfA ? (
                        (() => {
                          const cx = flow.pdfA.x * renderScale;
                          const cy = flow.pdfA.y * renderScale;
                          return (
                            <g data-testid="pdf-pick-marker-a">
                              <circle
                                cx={cx}
                                cy={cy}
                                r={MARKER_RADIUS}
                                fill={PDF_MARKER_COLOR}
                                stroke="#fff"
                                strokeWidth={2}
                                vectorEffect="non-scaling-size"
                              />
                              <text
                                x={cx}
                                y={cy + 1}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={9}
                                fontWeight={700}
                                fill="#fff"
                                fontFamily="system-ui, sans-serif"
                                vectorEffect="non-scaling-size"
                              >
                                A
                              </text>
                            </g>
                          );
                        })()
                      ) : null}
                      {flow.pdfB ? (
                        (() => {
                          const cx = flow.pdfB.x * renderScale;
                          const cy = flow.pdfB.y * renderScale;
                          return (
                            <g data-testid="pdf-pick-marker-b">
                              <circle
                                cx={cx}
                                cy={cy}
                                r={MARKER_RADIUS}
                                fill={PDF_MARKER_COLOR}
                                stroke="#fff"
                                strokeWidth={2}
                                vectorEffect="non-scaling-size"
                              />
                              <text
                                x={cx}
                                y={cy + 1}
                                textAnchor="middle"
                                dominantBaseline="middle"
                                fontSize={9}
                                fontWeight={700}
                                fill="#fff"
                                fontFamily="system-ui, sans-serif"
                                vectorEffect="non-scaling-size"
                              >
                                B
                              </text>
                            </g>
                          );
                        })()
                      ) : null}
                      {flow.pdfA && flow.pdfB ? (
                        (() => {
                          const ax = flow.pdfA.x * renderScale;
                          const ay = flow.pdfA.y * renderScale;
                          const bx = flow.pdfB.x * renderScale;
                          const by = flow.pdfB.y * renderScale;
                          return (
                            <line
                              data-testid="pdf-pick-line"
                              x1={ax}
                              y1={ay}
                              x2={bx}
                              y2={by}
                              stroke={PDF_LINE_COLOR}
                              strokeWidth={PDF_LINE_WIDTH}
                              strokeDasharray="4 4"
                              vectorEffect="non-scaling-stroke"
                            />
                          );
                        })()
                      ) : null}
                    </svg>,
                    annotationLayer,
                  )
                : null}
            </>
          ) : (
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--ff-text-muted)",
                fontFamily: "var(--ff-font-stack)",
                fontSize: 13,
              }}
            >
              Resolving PDF…
            </div>
          )}
        </div>
        <div style={dividerStyle} />
        <div
          ref={worldPaneRef}
          style={{
            ...splitPaneStyle(100 - SPLIT_PERCENT),
            // Task 15: the 3D pane is a transparent overlay
            // that shows the parent's <IfcViewer> through it.
            // `pointer-events: auto` during world-pick steps so
            // the wizard captures the click; `none` otherwise so
            // the parent's OBC.MouseNavigation keeps receiving
            // mouse events for rotate/pan/zoom. The cursor also
            // flips to a crosshair during pick steps so the user
            // knows the click is "armed".
            pointerEvents: isWorldPickStep ? "auto" : "none",
            cursor: isWorldPickStep ? "crosshair" : undefined,
          }}
          data-testid="mapping-view-world-pane"
          onClick={isWorldPickStep ? handleWorldClick : undefined}
        >
          {/*
            Task 15: the 3D line SVG is portaled into the
            parent's <IfcViewer> container (via
            `viewerRef.current.getContainer()`). This way the
            SVG's coord system is the same as the canvas's CSS
            pixel system — no offset math between the world
            pane and the canvas.

            zIndex 11 puts the SVG above the IfcViewer's debug
            overlay (zIndex 10) and stats panel. Pointer events
            disabled so the SVG never blocks the parent's
            MouseNavigation.
          */}
          {viewerRef.current?.getContainer && (worldScreenA || worldScreenB)
            ? createPortal(
                <svg
                  data-testid="mapping-view-line"
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    zIndex: 11,
                  }}
                  width="100%"
                  height="100%"
                >
                  {worldScreenA && worldScreenB && (
                    <line
                      x1={worldScreenA.x}
                      y1={worldScreenA.y}
                      x2={worldScreenB.x}
                      y2={worldScreenB.y}
                      stroke={LINE_COLOR}
                      strokeWidth={LINE_WIDTH}
                      strokeDasharray="4 4"
                    />
                  )}
                  {worldScreenA && (
                    <circle
                      cx={worldScreenA.x}
                      cy={worldScreenA.y}
                      r={MARKER_RADIUS}
                      fill={WORLD_MARKER_COLOR}
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  )}
                  {worldScreenB && (
                    <circle
                      cx={worldScreenB.x}
                      cy={worldScreenB.y}
                      r={MARKER_RADIUS}
                      fill={WORLD_MARKER_COLOR}
                      stroke="#fff"
                      strokeWidth={2}
                    />
                  )}
                </svg>,
                // Safe: getContainer() returns null only before
                // the IfcViewer's mount effect runs. The rAF
                // loop sets screen coords as soon as a pick
                // exists, so by the time the SVG renders the
                // container is mounted. createPortal with a
                // null target is a no-op in React, so the
                // marker just doesn't appear until then.
                viewerRef.current.getContainer() ?? document.body,
              )
            : null}
        </div>
      </div>
    </div>
  );
}
