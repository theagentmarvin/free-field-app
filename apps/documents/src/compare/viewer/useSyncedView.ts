// apps/documents/src/compare/viewer/useSyncedView.ts
//
// Shared pan/zoom transform for the compare panes. The math is pure
// (exported) so it can be unit-tested; the hook only holds state.

import { useCallback, useState } from "react";

import type { PtBox } from "../types";

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;
export const IDENTITY_VIEW: ViewTransform = { scale: 1, tx: 0, ty: 0 };

export type PaneId = 0 | 1;
export type PaneTarget = PaneId | "all";

export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Zoom by `factor`, keeping the content point under (px, py) fixed. */
export function zoomAt(view: ViewTransform, factor: number, px: number, py: number): ViewTransform {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k };
}

export function panBy(view: ViewTransform, dx: number, dy: number): ViewTransform {
  return { ...view, tx: view.tx + dx, ty: view.ty + dy };
}

export interface Size {
  width: number;
  height: number;
}

/** Fit content (raster px) inside the viewport, centred. */
export function fitView(content: Size, viewport: Size, padding = 16): ViewTransform {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
    return IDENTITY_VIEW;
  }
  const scale = clampScale(
    Math.min(
      (viewport.width - padding * 2) / content.width,
      (viewport.height - padding * 2) / content.height,
    ),
  );
  return {
    scale,
    tx: (viewport.width - content.width * scale) / 2,
    ty: (viewport.height - content.height * scale) / 2,
  };
}

/** Centre `box` (raster px) and scale it to fill `fraction` of the viewport. */
export function focusBox(box: PtBox, viewport: Size, fraction = 0.6, maxScale = 8): ViewTransform {
  const bw = Math.max(box.w, 4);
  const bh = Math.max(box.h, 4);
  const scale = Math.min(
    maxScale,
    clampScale(Math.min((viewport.width * fraction) / bw, (viewport.height * fraction) / bh)),
  );
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return { scale, tx: viewport.width / 2 - cx * scale, ty: viewport.height / 2 - cy * scale };
}

export interface SyncedViewState {
  views: [ViewTransform, ViewTransform];
  sync: boolean;
}

export function applyPaneUpdate(
  state: SyncedViewState,
  target: PaneTarget,
  next: ViewTransform,
): SyncedViewState {
  if (target === "all" || state.sync) return { ...state, views: [next, next] };
  const views: [ViewTransform, ViewTransform] = [state.views[0], state.views[1]];
  views[target] = next;
  return { ...state, views };
}

export function applySyncFlag(state: SyncedViewState, sync: boolean): SyncedViewState {
  if (sync === state.sync) return state;
  // Turning sync on: pane 1 follows pane 0.
  return sync ? { sync, views: [state.views[0], state.views[0]] } : { ...state, sync };
}

export function useSyncedView(initialSync = true) {
  const [state, setState] = useState<SyncedViewState>({
    views: [IDENTITY_VIEW, IDENTITY_VIEW],
    sync: initialSync,
  });

  /** Update from the previous transform of `pane` (mirrored when synced). */
  const update = useCallback((pane: PaneId, fn: (v: ViewTransform) => ViewTransform) => {
    setState((s) => applyPaneUpdate(s, pane, fn(s.views[pane])));
  }, []);

  const setView = useCallback((target: PaneTarget, view: ViewTransform) => {
    setState((s) => applyPaneUpdate(s, target, view));
  }, []);

  const setSync = useCallback((sync: boolean) => {
    setState((s) => applySyncFlag(s, sync));
  }, []);

  return { views: state.views, sync: state.sync, update, setView, setSync };
}
