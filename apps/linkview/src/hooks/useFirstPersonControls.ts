// apps/linkview/src/hooks/useFirstPersonControls.ts
//
// First-person (video-game style) controls for the LinkView right
// pane: mouse-drag look + WASD / arrow-key walking at eye height on
// the mapped storey. Restores the Task-21 walk-through on the shared
// persistent surface.
//
// Reuses the viewer handle's existing Task-21 camera API instead of a
// new engine path:
//   - `setRestrictedThirdPerson(eye, target)` once on activation —
//     zeroes the camera-controls mouse buttons + wheel so the default
//     orbit/truck/dolly can't drag the eye off the storey;
//   - `navigateTo(eye, target)` per look/walk update (instant
//     setLookAt, no tween);
//   - `releaseRestrictedCamera()` on deactivation/unmount — restores
//     the orbit mouse buttons for the other modules that share the
//     same viewer instance.
// (OBC's own "FirstPerson" navigation mode is not used: it only pins
// the controls distance to 1 and keeps wheel-dolly — no keyboard walk,
// no eye-height lock, and its drag still orbits.)
//
// The CAMERA is the single source of truth: every update reads the
// current pose, derives bearing/pitch from it, applies the delta and
// writes the new pose. The marker follows through LinkviewApp's
// existing camera → PDF back-projection loop.

import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { IfcViewerHandle, ViewerPose } from "@ff/viewer-react";

import {
  applyLookDelta,
  bearingFromPose,
  firstPersonPose,
  isEditableTarget,
  pitchFromPose,
  walkDelta,
  walkInputFromKeys,
  RUN_MULTIPLIER,
  WALK_KEY_CODES,
  WALK_SPEED,
  type EditableLike,
} from "../linkviewNav";

export interface FirstPersonControlsOptions {
  /** The shared-surface handle (right pane). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** The right pane's surface host element (drag-look listens here). */
  hostEl: HTMLElement | null;
  /** True while the first-person nav view is engaged. */
  active: boolean;
  /** Floor elevation of the mapped storey (eye = floor + eye height). */
  floorZ: number;
  /** Fallback bearing when the pose's azimuth is degenerate. */
  bearingRef: RefObject<number>;
}

export interface FirstPersonControls {
  /** Hold a walk key (KeyW/KeyS/...) from an on-screen control. */
  pressKey: (code: string) => void;
  /** Release a key held with `pressKey`. */
  releaseKey: (code: string) => void;
}

/**
 * Drag distance (px) before a press counts as a look-drag. MUST equal
 * the viewer's click-vs-drag pick guard (IfcViewer `attachDragGuard`,
 * 5 px): a press that moves less than this neither looks around nor is
 * discarded by the pick guard, so it selects; a press that moves more
 * looks around and does NOT select.
 */
export const DRAG_THRESHOLD_PX = 5;

function writePose(handle: IfcViewerHandle, pose: ViewerPose): void {
  handle.navigateTo(
    { x: pose.pos[0], y: pose.pos[1], z: pose.pos[2] },
    { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
  );
}

export function useFirstPersonControls({
  viewerRef,
  hostEl,
  active,
  floorZ,
  bearingRef,
}: FirstPersonControlsOptions): FirstPersonControls {
  const floorZRef = useRef(floorZ);
  floorZRef.current = floorZ;

  // ── Lock / release the orbit controls ───────────────────────────
  useEffect(() => {
    if (!active) return;
    const handle = viewerRef.current;
    if (!handle) return;
    const pose = handle.getPose({ silent: true });
    if (pose) {
      handle.setRestrictedThirdPerson(
        { x: pose.pos[0], y: pose.pos[1], z: pose.pos[2] },
        { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
      );
    }
    return () => {
      // Same instance is shared with the Models route — hand the
      // orbit controls back when LinkView's nav view goes away.
      viewerRef.current?.releaseRestrictedCamera();
    };
  }, [active, viewerRef]);

  // Re-pose the camera from the CURRENT pose with a new look/position.
  const step = (
    look: (b: number, p: number) => { bearing: number; pitch: number },
    move: (bearing: number) => { dx: number; dz: number },
  ): void => {
    const handle = viewerRef.current;
    if (!handle) return;
    const pose = handle.getPose({ silent: true });
    if (!pose) return;
    const bearing0 = bearingFromPose(pose) ?? bearingRef.current ?? 0;
    const { bearing, pitch } = look(bearing0, pitchFromPose(pose));
    const { dx, dz } = move(bearing);
    writePose(
      handle,
      firstPersonPose(
        { x: pose.pos[0] + dx, z: pose.pos[2] + dz },
        floorZRef.current,
        bearing,
        pitch,
        pose,
      ),
    );
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  // ── Mouse / touch drag-to-look on the 3D canvas ─────────────────
  useEffect(() => {
    if (!active || !hostEl) return;
    let drag: {
      id: number;
      startX: number;
      startY: number;
      lastX: number;
      lastY: number;
      looking: boolean;
    } | null = null;

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0 || e.isPrimary === false) return;
      // Only presses on the WebGL canvas — never the overlay chrome.
      const t = e.target as { tagName?: string } | null;
      if (!t || (t.tagName ?? "").toUpperCase() !== "CANVAS") return;
      drag = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        looking: false,
      };
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      if (!drag.looking) {
        const moved = Math.hypot(
          e.clientX - drag.startX,
          e.clientY - drag.startY,
        );
        if (moved <= DRAG_THRESHOLD_PX) return;
        drag.looking = true;
      }
      const dx = e.clientX - drag.lastX;
      const dy = e.clientY - drag.lastY;
      drag.lastX = e.clientX;
      drag.lastY = e.clientY;
      if (dx === 0 && dy === 0) return;
      stepRef.current(
        (b, p) => applyLookDelta({ bearing: b, pitch: p }, dx, dy),
        () => ({ dx: 0, dz: 0 }),
      );
    };
    const onUp = (e: PointerEvent): void => {
      if (drag && e.pointerId === drag.id) drag = null;
    };

    hostEl.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      hostEl.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [active, hostEl]);

  // ── WASD / arrow-key walking ────────────────────────────────────
  // Keys only walk while the 3D pane is the user's target: the pointer
  // is over the host, or focus is inside it. Otherwise W/A/S/D and the
  // arrows belong to the rest of the page (the PDF pane, lists, other
  // shortcuts) and must not move the camera.
  const keysRef = useRef(new Set<string>());
  const walkStartRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof requestAnimationFrame !== "function") return;
    const keys = keysRef.current;
    let run = false;
    let rafId: number | null = null;
    let last = 0;
    let pointerOver = false;

    const tick = (time: number): void => {
      rafId = null;
      if (keys.size === 0) return;
      const dt = last === 0 ? 1 / 60 : Math.min((time - last) / 1000, 0.1);
      last = time;
      const input = walkInputFromKeys(keys);
      const distance = WALK_SPEED * (run ? RUN_MULTIPLIER : 1) * dt;
      stepRef.current(
        (b, p) => ({ bearing: b, pitch: p }),
        (bearing) => walkDelta(bearing, input, distance),
      );
      rafId = requestAnimationFrame(tick);
    };
    const start = (): void => {
      if (rafId !== null) return;
      last = 0;
      rafId = requestAnimationFrame(tick);
    };
    walkStartRef.current = start;

    const hostTargeted = (): boolean => {
      if (!hostEl) return false;
      if (pointerOver) return true;
      const focused =
        typeof document !== "undefined" ? document.activeElement : null;
      return focused !== null && hostEl.contains(focused);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      run = e.shiftKey;
      if (!WALK_KEY_CODES.has(e.code)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target as EditableLike | null)) return;
      if (!hostTargeted()) return;
      // Arrow keys would otherwise scroll a focused container.
      e.preventDefault();
      keys.add(e.code);
      start();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      run = e.shiftKey;
      keys.delete(e.code);
    };
    const onBlur = (): void => {
      keys.clear();
    };
    const onEnter = (): void => {
      pointerOver = true;
    };
    const onLeave = (): void => {
      pointerOver = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    hostEl?.addEventListener("pointerenter", onEnter);
    hostEl?.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      hostEl?.removeEventListener("pointerenter", onEnter);
      hostEl?.removeEventListener("pointerleave", onLeave);
      if (rafId !== null) cancelAnimationFrame(rafId);
      walkStartRef.current = null;
      keys.clear();
    };
  }, [active, hostEl]);

  // On-screen walk buttons (touch): press/release a virtual walk key
  // through the same loop as the keyboard.
  const pressKey = useCallback((code: string): void => {
    if (!WALK_KEY_CODES.has(code)) return;
    keysRef.current.add(code);
    walkStartRef.current?.();
  }, []);
  const releaseKey = useCallback((code: string): void => {
    keysRef.current.delete(code);
  }, []);
  return { pressKey, releaseKey };
}
