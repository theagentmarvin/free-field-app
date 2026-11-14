// apps/settings/src/shell/ViewerKeepAlive.tsx
//
// Wave 52 — generalized persistent viewer layer (renamed from
// ModelsKeepAlive, wave 43). The shared 3D surface (<IfcViewer> +
// overlays) survives module switches: lazy-mounted on the first
// /models OR /linkview visit, then kept alive for the session. The
// heavy load + tessellation happens exactly once; the full-screen
// loading overlay only ever shows on that first cold visit.
//
// Wave 52 keeps the surface mounted across BOTH /models and /linkview
// and portals it into whichever route is active:
//
//   - /models  → ModelsApp renders <ViewerSurfaceHostSlot> in its
//                viewport and the surface's internal <ViewerToolbar>.
//   - /linkview → LinkviewApp portals the SAME surface node into its
//                right pane and mounts its own <LinkviewToolbar>
//                (the surface's internal toolbar is suppressed).
//
// Only one host is active at a time (route-driven); the other's slot
// renders nothing. Because the surface React tree never remounts —
// only its portal target changes — the WebGL canvas, camera,
// selection, and visibility state all survive the Models↔Linkview
// switch (verified with a manual smoke note; jsdom cannot exercise a
// live WebGL context).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";

import { type IfcViewerHandle } from "@ff/viewer-react";
import { RequireProjectMember } from "@ff/auth";
import {
  PersistentViewerSurface,
  ViewerSurfaceHostContext,
  type PersistentViewerSurfaceProps,
  type ViewerSurfaceHostValue,
} from "@free-field/models";
// Direct file import (not the documents barrel): the shell only needs
// the flag, not the Documents route's PDF/three.js import graph.
import { useDocumentsViewState } from "../../../documents/src/documentsViewState";
import { ErrorBoundary } from "./ErrorBoundary";

export function ViewerKeepAlive({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { pathname } = useLocation();
  const onModels =
    pathname === "/models" || pathname.startsWith("/models/");
  const onLinkview =
    pathname === "/linkview" || pathname.startsWith("/linkview/");
  // Wave 56 — the Documents route now also hosts the shared surface
  // (the mapping view needs the 3D viewer underneath the PDF overlay
  // so model/level toggles are visible while mapping).
  const onDocuments =
    pathname === "/documents" || pathname.startsWith("/documents/");
  const active = onModels || onLinkview || onDocuments;

  // Wave 63 — on /documents an open PDF is an opaque full-bleed layer
  // over the shared 3D surface: pause the surface's rendering while it
  // is covered (it resumes the moment the PDF closes or the route
  // changes; loading and picking state are untouched).
  const documentsPdfOpen = useDocumentsViewState((s) => s.pdfOpen);
  const renderPaused = onDocuments && documentsPdfOpen;

  // Lazy mount on first visit to either route, then keep alive forever.
  const [mounted, setMounted] = useState(active);
  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  // The single shared viewer handle, owned here and threaded to both
  // the kernel and (via context) the active route's chrome.
  const viewerRef = useRef<IfcViewerHandle>(null);

  // The active route's portal target element.
  const [hostNode, setHostNode] = useState<HTMLElement | null>(null);
  const registerHost = useCallback(
    (node: HTMLElement | null) => setHostNode(node),
    [],
  );

  // True once the surface has ≥1 loaded model — Linkview reads this to
  // suppress its left-pane loading overlay (the Dexie load is warm).
  const [surfaceLoaded, setSurfaceLoaded] = useState(false);
  const onLoadedModelsChange = useCallback(
    (loaded: boolean) => setSurfaceLoaded(loaded),
    [],
  );

  // Coming back from a route with no host the surface can be
  // stale-sized — nudge the viewer to re-fit on the next frame.
  useEffect(() => {
    if (!active) return;
    const raf = requestAnimationFrame(() =>
      window.dispatchEvent(new Event("resize")),
    );
    return () => cancelAnimationFrame(raf);
  }, [active]);

  // `renderPaused` is forwarded by the surface to <IfcViewer renderPaused>.
  const surfaceProps: PersistentViewerSurfaceProps = {
    viewerRef,
    hostNode,
    showViewerToolbar: onModels,
    onLoadedModelsChange,
    renderPaused,
  };

  const value: ViewerSurfaceHostValue = {
    viewerRef,
    registerHost,
    surfaceLoaded,
  };

  return (
    <ViewerSurfaceHostContext.Provider value={value}>
      <div style={{ display: "contents" }} data-testid="viewer-keepalive" data-visible={active}>
        {children}
        {mounted && (
          <RequireProjectMember>
            {/* Wave 64 — a crash in the 3D surface stays local: the
                route chrome keeps working and the error (with Retry)
                shows in the active route's viewport. */}
            <ErrorBoundary label="The 3D viewer" fallbackContainer={hostNode}>
              <PersistentViewerSurface {...surfaceProps} />
            </ErrorBoundary>
          </RequireProjectMember>
        )}
      </div>
    </ViewerSurfaceHostContext.Provider>
  );
}