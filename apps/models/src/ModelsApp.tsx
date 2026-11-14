// apps/models/src/ModelsApp.tsx
//
// Wave 52 — the /models route chrome.
//
// The 3D surface (the <IfcViewer> + overlays) now lives in the
// persistent kernel (<PersistentViewerSurface>) owned by the settings
// shell's <ViewerKeepAlive>. ModelsApp is now ONLY the chrome that
// surrounds that surface on the /models route: the viewport slot
// (<ViewerSurfaceHostSlot>) the surface portals into, the floating
// nav toolbar, and the single nav panel slot (Models & Levels /
// Filters / Tasks / Properties).
//
// The building auto-selection + filter/selection pipeline moved to
// the kernel so one surface serves both routes.

import { type ReactNode, type RefObject } from "react";

import { type IfcViewerHandle } from "@ff/viewer-react";

import { ViewerToolsProvider } from "@ff/viewer-tools";

import { modelsDataSource } from "./modelsDataSource";
import MainAppChrome from "./MainAppChrome";

export interface ModelsAppProps {
  /** The shared <IfcViewer> handle ref (from <ViewerKeepAlive>). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Register the viewport slot as the surface's portal target. */
  registerHost: (node: HTMLElement | null) => void;
}

/**
 * Entry component for the `/models` route.
 *
 * The /models route is a READ-ONLY surface: no building creation, IFC
 * upload, or calibration wizard (those live in the Settings module).
 */
export default function ModelsApp({
  viewerRef,
  registerHost,
}: ModelsAppProps): ReactNode {
  return (
    <ViewerToolsProvider dataSource={modelsDataSource}>
      <MainAppChrome viewerRef={viewerRef} registerHost={registerHost} />
    </ViewerToolsProvider>
  );
}