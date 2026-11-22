import { useTaskBuildingIndex } from "./taskBuilding";
import { useEffect, useMemo, useState } from "react";


import { useProjectId } from "@ff/auth";

import {
  clusterProjectedPins,
  extractPins,
  IDLE_REPROJECT_MS,
  mergePins,
  pendingPins,
  pinsForBuilding,
  PIN_FEED_LIMIT,
  restorePinView,
  type CalloutHandle,
  type LocatableTask,
  type TaskPin,
} from "./callouts";
import { formatTaskNum, statusColor } from "./logic";
import { useTasksSource } from "./tasksSource";
import { useOutboxRows } from "./useOutboxRows";

/**
 * 3D task callouts (plan §5). Cloud-first like the list: the Firestore
 * live query is the truth feed, outbox `added`/`failed` creates project
 * early (the pending row's payload carries the location). Markers are
 * re-projected every animation frame through `handle.worldToScreen` —
 * the same per-frame path the calibration 3D line uses, glued to the
 * model as the camera moves. A null projection (world not mounted /
 * point behind the camera) hides the chip for that frame.
 *
 * Click = the §0-idea-3 trick: `restorePinView` glides the camera back
 * to the author's viewpoint and highlights the element.
 *
 * Density (Wave 1A): overlapping chips are unreadable, so the VISIBLE
 * pins are bucketed on a screen grid (48 px cells) and each bucket
 * renders ONE chip. A bucket of one looks exactly like today; a bucket
 * of n renders `T{num} +{n-1}` and opens the representative (the
 * lowest T-num — stable under camera jitter). Off-screen pins are
 * culled BEFORE clustering, so a cluster never counts a hidden pin.
 */

export interface TaskCalloutLayer3DProps {
  /** Structural access to the IfcViewerHandle — ff-tasks-react stays
   *  viewer-free by depending only on the CalloutHandle surface. */
  getHandle: () => CalloutHandle | null;
  onOpenTask?: (pin: TaskPin) => void;
  /** Active building: only its pins (plus legacy pins without a
   *  building) render. Omit to show every building's pins. */
  buildingId?: string | null;
}

type Projected = { pin: TaskPin; x: number; y: number };

/** Cluster key — the task number FIRST so the clusterer can pick the
 *  lowest T-num as the stable representative. */
function pinKey(pin: TaskPin): string {
  return `${pin.num}:${pin.taskId}`;
}

/** A re-projection that moved every visible pin by no more than this
 *  many CSS px (and changed no pin's visibility) is not committed to
 *  state — no React render for sub-pixel camera jitter. */
const PIN_MOVE_EPSILON_PX = 0.5;

export function TaskCalloutLayer3D({
  getHandle,
  onOpenTask,
  buildingId,
}: TaskCalloutLayer3DProps): JSX.Element | null {
  const source = useTasksSource();
  const projectId = useProjectId();

  const [cloud, setCloud] = useState<LocatableTask[]>([]);
  useEffect(() => {
    if (!projectId) {
      setCloud([]);
      return;
    }
    let unsub = () => {};
    try {
      unsub = source.watchTasks(projectId, null, (t) => setCloud(t as LocatableTask[]), PIN_FEED_LIMIT);
    } catch {
      /* no backend — pins from the outbox still render */
    }
    return () => unsub();
  }, [source, projectId]);

  const rows = useOutboxRows(projectId);
  const buildingIndex = useTaskBuildingIndex();

  const pins = useMemo(
    () =>
      pinsForBuilding(
        mergePins(extractPins(cloud), pendingPins(rows, source.overlaySending)),
        buildingId,
        buildingIndex,
      ),
    [cloud, rows, source.overlaySending, buildingId, buildingIndex],
  );

  const [projected, setProjected] = useState<Projected[]>([]);

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    // Wave 30: idle-frame gate. This loop used to re-project EVERY
    // pin on EVERY frame forever — per pin a `Vector3` allocation,
    // a matrix multiply and a forced `getBoundingClientRect`, plus
    // two `positionsKey` string builds over the whole list — even
    // while the camera and the canvas were completely still, when
    // the answer cannot possibly change. The viewer now hands us an
    // opaque projection token; when it is unchanged we skip the
    // burst entirely.
    //
    // `IDLE_REPROJECT_MS` is the safety net: the token covers camera
    // and viewport, not the things that move a world point itself or
    // change layout behind our back. One full burst per second costs
    // nothing and bounds any staleness to a second instead of
    // "until the user orbits". A re-project whose pins all moved by
    // ≤ PIN_MOVE_EPSILON_PX (same visibility) doesn't re-render.
    //
    // The burst itself is allocation-light: one reused query point,
    // flat typed arrays for the projected/committed coordinates, and
    // `Projected` wrappers built only when a change is committed.
    let lastRevision: number | null = null;
    let lastBurstAt = 0;
    const n = pins.length;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const vis = new Uint8Array(n);
    const committedXs = new Float64Array(n);
    const committedYs = new Float64Array(n);
    const committedVis = new Uint8Array(n);
    // The first burst after (re)starting always commits, so a pin
    // removed from `pins` can't linger in the previous state.
    let committed = false;
    const query = { x: 0, y: 0, z: 0 };
    const loop = () => {
      if (cancelled) return;
      const handle = getHandle();
      if (handle) {
        // `undefined` = a host that predates the token ⇒ always dirty.
        const revision = handle.getViewportRevision?.() ?? null;
        const now = performance.now();
        const viewChanged = lastRevision === null || revision !== lastRevision;
        if (viewChanged || now - lastBurstAt >= IDLE_REPROJECT_MS) {
          lastRevision = revision;
          lastBurstAt = now;
          let changed = !committed;
          for (let i = 0; i < n; i++) {
            const wp = pins[i].worldPoint;
            query.x = wp[0];
            query.y = wp[1];
            query.z = wp[2];
            const s = handle.worldToScreen(query);
            if (s) {
              vis[i] = 1;
              xs[i] = s.x;
              ys[i] = s.y;
            } else {
              vis[i] = 0;
            }
            if (!changed) {
              if (vis[i] !== committedVis[i]) changed = true;
              else if (
                vis[i] === 1 &&
                (Math.abs(xs[i] - committedXs[i]) > PIN_MOVE_EPSILON_PX ||
                  Math.abs(ys[i] - committedYs[i]) > PIN_MOVE_EPSILON_PX)
              ) {
                changed = true;
              }
            }
          }
          if (changed) {
            committed = true;
            committedXs.set(xs);
            committedYs.set(ys);
            committedVis.set(vis);
            // The state keeps the wrapper shape so render can key off
            // pin identity + coords (visible pins only, in pin order —
            // same contract as the former `projectPins` path).
            const next: Projected[] = [];
            for (let i = 0; i < n; i++) {
              if (vis[i] === 1) next.push({ pin: pins[i], x: xs[i], y: ys[i] });
            }
            setProjected(next);
          }
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pins, getHandle]);

  // Marker nodes are DOM-overlayed, not a portal: Viewer's wrapper is
  // already position:relative and worldToScreen returns canvas-relative
  // px — the canvas fills the wrapper, so no offset math is needed.

  // Density: fold the visible pins into screen-grid clusters. The
  // memo only recomputes when the projected set changed (the rAF loop
  // keeps the previous state when the positions are identical).
  const clusters = useMemo(() => {
    const byKey = new Map<string, TaskPin>();
    const entries = projected.map((p) => {
      const key = pinKey(p.pin);
      byKey.set(key, p.pin);
      return { key, x: p.x, y: p.y };
    });
    return clusterProjectedPins(entries).map((cluster) => ({
      cluster,
      pin: byKey.get(cluster.representative.key) ?? null,
    }));
  }, [projected]);

  if (projected.length === 0) return null;

  return (
    <div
      className="ff-callout-layer"
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }}
      role="group"
      aria-label="Task callouts"
    >
      {clusters.map(({ cluster, pin }) => {
        if (!pin) return null;
        const multi = cluster.count > 1;
        // Maintainer VDC 2026-11-02: chips carry the task ID only — full titles
        // live in the detail sheet and remain on the accessible label.
        const label = multi ? `${formatTaskNum(pin.num)} +${cluster.count - 1}` : formatTaskNum(pin.num);
        const aria = multi
          ? `Task ${pin.num} — ${pin.title} (+${cluster.count - 1} more in this cluster)`
          : `Task ${pin.taskId} — ${pin.title}`;
        return (
          <button
            key={cluster.representative.key}
            type="button"
            className={`ff-callout${pin.pending ? " ff-callout--pending" : ""}${multi ? " ff-callout--cluster" : ""}`}
            aria-label={aria}
            onClick={() => {
              const handle = getHandle();
              if (handle) restorePinView(handle, pin);
              onOpenTask?.(pin);
            }}
            style={{
              position: "absolute",
              left: cluster.x,
              top: cluster.y,
              transform: "translate(-50%, -120%)",
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 12,
              border: "1px solid #d0d3d6",
              background: "rgba(255,255,255,0.94)",
              boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
              cursor: "pointer",
              fontSize: 12,
              opacity: pin.pending ? 0.55 : 1,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: statusColor(pin.status),
                display: "inline-block",
                flex: "0 0 auto",
              }}
            />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{label}</span>
            {pin.pending && <span style={{ color: "#1a73e8" }}>⋯</span>}
          </button>
        );
      })}
    </div>
  );
}
