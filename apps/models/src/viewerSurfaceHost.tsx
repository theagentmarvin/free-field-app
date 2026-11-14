// apps/models/src/viewerSurfaceHost.tsx
//
// Wave 52 — the portal-host seam shared by the Models and Linkview
// routes. The persistent viewer surface lives in the settings shell's
// <ViewerKeepAlive> (one IfcViewer instance); the ACTIVE route renders
// a <ViewerSurfaceHostSlot> into its viewport and registers that DOM
// node here so the surface can be teleported into it via a React
// portal. Only one host is active at a time (route-driven); the
// other's slot renders nothing.

import {
  createContext,
  useCallback,
  useContext,
  type RefObject,
} from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

export interface ViewerSurfaceHostValue {
  /** The single shared viewer handle (owned by <ViewerKeepAlive>). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Register/unregister the active route's portal target element. */
  registerHost: (node: HTMLElement | null) => void;
  /** True once the persistent surface has loaded ≥1 model. */
  surfaceLoaded: boolean;
}

export const ViewerSurfaceHostContext =
  createContext<ViewerSurfaceHostValue | null>(null);

/** Consume the host seam. Provided by apps/settings' <ViewerKeepAlive>. */
export function useViewerSurfaceHost(): ViewerSurfaceHostValue {
  const value = useContext(ViewerSurfaceHostContext);
  if (!value) {
    throw new Error(
      "useViewerSurfaceHost must be used within <ViewerKeepAlive>",
    );
  }
  return value;
}

export interface ViewerSurfaceHostSlotProps {
  /** Register the slot's element as the active portal target. */
  registerHost: (node: HTMLElement | null) => void;
  /** Test id for the slot marker. */
  testId?: string;
}

/**
 * A viewport slot the ACTIVE route renders in place of its viewer. The
 * persistent surface is portaled into this element. The surface React
 * tree (and its WebGL canvas) keeps its identity across the
 * Models↔Linkview route switch — only the container element changes.
 */
export function ViewerSurfaceHostSlot({
  registerHost,
  testId,
}: ViewerSurfaceHostSlotProps): JSX.Element {
  // Callback ref: registers synchronously during commit and unregisters
  // on unmount (React calls the ref with `null`). A stable identity is
  // essential — a fresh function each render would make React detach and
  // re-attach the node every render.
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      registerHost(node);
    },
    [registerHost],
  );

  return (
    <div
      ref={setRef}
      data-testid={testId}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    />
  );
}