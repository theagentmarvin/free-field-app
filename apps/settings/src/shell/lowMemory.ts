// apps/settings/src/shell/lowMemory.ts
//
// Host wiring for the viewer's low-RAM tuning (`setMemoryPressure`, wave 78).
// The viewer only ever shipped the mechanism; nothing in apps/ called it, so a
// 3 GB tablet ran with the desktop budgets. The host now asks for the
// "low" pressure level on devices that are likely to be short of memory.
//
// Deliberately conservative: only the "low" level (never "critical"), and only
// for a positive signal:
//   - `navigator.deviceMemory` <= 4 (GB, Chromium/Android; the value is
//     bucketed by the browser, so 4 means "4 or less"), or
//   - iOS / iPadOS (WebKit gives a tab far less memory than the device has;
//     `deviceMemory` does not exist there).
// Everything else is unchanged, including every browser without either signal.
//
// "low" in the viewer = invisible-tile cache scaled to 25% of the engine default
// and a coarser screen-size cull (quality -0.5). It never unloads a model.
//
// QA override (localStorage `ff.lowMemory`): "1" forces it on, "0" forces it off.

import { useEffect } from "react";
import type { RefObject } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";
import { useViewerHandle } from "@ff/viewer-tools";

import { shouldUseLowMemoryTuning } from "./lowMemoryDetect";

/**
 * Apply the "low" memory-pressure level to the shared viewer once it exists
 * (and again whenever a model finishes loading: the viewer only applies the
 * engine quality to models that exist, and records the level before the
 * engine is up, so the level is cycled to re-apply it). Cheap and idempotent.
 */
export function useLowMemoryPressure(
  viewerRef: RefObject<IfcViewerHandle>,
  modelsLoaded: boolean,
): void {
  const handle = useViewerHandle(viewerRef);
  useEffect(() => {
    if (!handle || !shouldUseLowMemoryTuning()) return;
    try {
      handle.setMemoryPressure("none");
      handle.setMemoryPressure("low");
    } catch (err) {
      console.warn("[low-memory] could not apply the memory pressure level", err);
    }
  }, [handle, modelsLoaded]);
}
