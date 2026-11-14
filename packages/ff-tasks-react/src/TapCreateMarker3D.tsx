import { useEffect, useRef, useState } from "react";

import type { TaskLocation } from "@ff/firestore";

import { IDLE_REPROJECT_MS, type CalloutHandle, type PinPose, type Vec3 } from "./callouts";

/**
 * 3D tap-to-create + marker (Wave 5B). Pure of Firebase *and* the
 * viewer package: it talks to the viewer only through the structural
 * `CalloutHandle` (augmented with `getSelectionWorldCenter`) and hands
 * the built `TaskLocation` to `onCreate` — the host owns the compose
 * sheet.
 *
 * The + button anchors at the projected pick point: Wave 20 prefers
 * the REAL click point the viewer stashed for the current selection
 * (canvas pick — synchronous read via `getSelectionWorldPoint`); the
 * bbox centre resolved through `getSelectionWorldCenter` (async,
 * BoundingBoxer-backed) remains the fallback for programmatic
 * selections that carry no click point. The world point is resolved
 * ONCE per selection change, then re-projected every frame through
 * `worldToScreen` so the marker tracks the camera without re-running
 * the boxer. A null projection (behind the camera / world unmounted)
 * hides the button for that frame. The button disappears when the
 * selection clears or once `onCreate` fires (compose opens).
 */

export interface TapCreateMarker3DProps {
  getHandle: () => CalloutHandle | null;
  /** active storey name from the host tool store (may be null) */
  storeyName?: string | null;
  /** tap → the exact TaskLocation the compose sheet + outbox expect */
  onCreate: (location: TaskLocation) => void;
}

interface ElementRef {
  modelId: string;
  expressId: number;
}

function flattenSelection(sel: ReadonlyMap<string, ReadonlySet<number>>): ElementRef[] {
  const out: ElementRef[] = [];
  for (const [modelId, ids] of sel) {
    for (const expressId of ids) out.push({ modelId, expressId });
  }
  return out;
}

function selectionKey(list: readonly ElementRef[]): string {
  return list.map((e) => `${e.modelId}:${e.expressId}`).join("|");
}

export function TapCreateMarker3D({
  getHandle,
  storeyName = null,
  onCreate,
}: TapCreateMarker3DProps): JSX.Element | null {
  const [elements, setElements] = useState<ElementRef[]>([]);
  const [screen, setScreen] = useState<{ x: number; y: number } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const elementsRef = useRef<ElementRef[]>([]);
  const worldPointRef = useRef<Vec3 | null>(null);
  const dismissedRef = useRef(false);
  const selectionKeyRef = useRef<string>("");
  const centerSeqRef = useRef(0);

  const onCreateRef = useRef(onCreate);
  onCreateRef.current = onCreate;
  const storeyRef = useRef(storeyName);
  storeyRef.current = storeyName;

  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    // Wave 30: idle-frame gate for the marker's own re-projection.
    // `worldToScreen` per frame is one pin's worth of work, but it is
    // a `Vector3` allocation plus a matrix multiply plus a forced
    // `getBoundingClientRect` — every frame, forever, on a scene that
    // may be completely still. Skip it while the viewer reports the
    // projection has not changed; `IDLE_REPROJECT_MS` is the safety
    // net for anything that moves the point without moving the
    // camera, and a handle without the token stays always-dirty.
    let lastRevision: number | null = null;
    let lastBurstAt = 0;

    const resolveCenter = async (
      handle: CalloutHandle,
      key: string,
      seq: number,
    ): Promise<void> => {
      // Wave 20: if the current selection came from a canvas pick,
      // the viewer already stashes the TRUE click point — use it
      // directly (synchronous, no boxer) so the marker lands exactly
      // where the user tapped instead of at the element's centre.
      const picked = handle.getSelectionWorldPoint?.() ?? null;
      if (picked) {
        if (cancelled || seq !== centerSeqRef.current) return;
        const nowKey = selectionKey(flattenSelection(handle.getSelection?.() ?? new Map()));
        if (nowKey !== key) return;
        worldPointRef.current = [picked.x, picked.y, picked.z];
        const s = handle.worldToScreen({ x: picked.x, y: picked.y, z: picked.z });
        setScreen((prev) => (prev && prev.x === s?.x && prev.y === s?.y ? prev : s));
        return;
      }
      // Wave 21: the click's id pass has already landed (that's why
      // the selection key changed) but the depth-pass point is still
      // in flight — wait for it instead of committing to the bbox
      // centre. Poll while the viewer reports the pick pending
      // (bounded ~600 ms; the deferred point is ~60 ms — the bound is
      // paranoia), then fall through to the boxer for programmatic
      // selections that never carry a point.
      if (handle.isSelectionPointPending?.()) {
        const deadline = Date.now() + 600;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 25));
          if (cancelled || seq !== centerSeqRef.current) return;
          const late = handle.getSelectionWorldPoint?.() ?? null;
          if (late) {
            const lateKey = selectionKey(flattenSelection(handle.getSelection?.() ?? new Map()));
            if (lateKey !== key) return;
            worldPointRef.current = [late.x, late.y, late.z];
            const s = handle.worldToScreen({ x: late.x, y: late.y, z: late.z });
            setScreen((prev) => (prev && prev.x === s?.x && prev.y === s?.y ? prev : s));
            return;
          }
          if (!handle.isSelectionPointPending?.()) break;
        }
      }
      const center = await handle.getSelectionWorldCenter?.();
      if (cancelled || seq !== centerSeqRef.current) return;
      // The boxer ran async — only commit if the selection is unchanged.
      const nowKey = selectionKey(flattenSelection(handle.getSelection?.() ?? new Map()));
      if (nowKey !== key) return;
      worldPointRef.current = center ? [center.x, center.y, center.z] : null;
      if (center) {
        const s = handle.worldToScreen({ x: center.x, y: center.y, z: center.z });
        setScreen((prev) => (prev && prev.x === s?.x && prev.y === s?.y ? prev : s));
      }
    };

    const loop = (): void => {
      if (cancelled) return;
      const handle = getHandle();
      if (handle) {
        const sel = handle.getSelection?.();
        const flat = sel ? flattenSelection(sel) : [];
        const key = selectionKey(flat);

        if (key !== selectionKeyRef.current) {
          selectionKeyRef.current = key;
          elementsRef.current = flat;
          setElements(flat);
          // a fresh selection re-arms the marker after a previous
          // compose-open dismissed it
          dismissedRef.current = false;
          setDismissed(false);
          // invalidate any in-flight boxer resolution on a selection
          // change, so a stale centre never lands
          centerSeqRef.current += 1;
          // Wave 21b: drop the PREVIOUS anchor on every selection
          // change. Keeping it alive while the new point resolved
          // showed the marker at the OLD click position for ~200 ms
          // during fast re-selection — visually indistinguishable
          // from the bbox-centre bug the boss reported.
          worldPointRef.current = null;
          if (flat.length > 0) {
            void resolveCenter(handle, key, centerSeqRef.current);
          }
        }

        const wp = worldPointRef.current;
        if (wp && !dismissedRef.current) {
          const revision = handle.getViewportRevision?.() ?? null;
          const now = performance.now();
          if (
            lastRevision === null ||
            revision !== lastRevision ||
            now - lastBurstAt >= IDLE_REPROJECT_MS
          ) {
            lastRevision = revision;
            lastBurstAt = now;
            const s = handle.worldToScreen({ x: wp[0], y: wp[1], z: wp[2] });
            setScreen((prev) => (prev && prev.x === s?.x && prev.y === s?.y ? prev : s));
          }
        } else {
          // No anchor on screen (cleared, dismissed, or between
          // selections): re-arm the gate so the next anchor is
          // projected on the frame it appears, not the next camera
          // move. The token is null when the host predates it, which
          // keeps every frame dirty exactly as before wave 30.
          lastRevision = null;
          setScreen((prev) => (prev === null ? prev : null));
        }
      }
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [getHandle]);

  if (elements.length === 0 || dismissed || !screen) return null;

  function handleTap(): void {
    const handle = getHandle();
    const pose: PinPose | null = handle?.getPose?.() ?? null;
    const location: TaskLocation = {
      storeyName: storeyRef.current,
      bim: {
        elements: elementsRef.current,
        // the anchor world point — the real click point when the
        // selection came from a canvas pick (wave 20), else the bbox
        // centre; fall back to the capture look-at only if neither
        // produced one
        worldPoint: worldPointRef.current ?? (pose ? pose.target : null),
        cameraPose: pose,
      },
      pdf: null,
    };
    dismissedRef.current = true;
    setDismissed(true);
    onCreateRef.current(location);
  }

  return (
    <button
      type="button"
      className="ff-task-create-marker"
      aria-label="Add task here"
      onClick={handleTap}
      style={{
        position: "absolute",
        left: screen.x,
        top: screen.y,
        transform: "translate(-50%, -50%)",
        zIndex: 25,
        pointerEvents: "auto",
        width: 32,
        height: 32,
        borderRadius: "50%",
        border: "none",
        background: "#1a73e8",
        color: "#fff",
        fontSize: 20,
        lineHeight: 1,
        cursor: "pointer",
        display: "grid",
        placeItems: "center",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
      }}
    >
      +
    </button>
  );
}