// packages/ff-viewer-tools/src/hooks/useFloorPlanOverlay.ts
//
// Task 23: renders a calibrated PDF as a textured plane in the
// 3D viewer scene. The hook owns the full pipeline:
//
//   PDF blob (Dexie) → pdf.js render → off-screen canvas →
//   calibration-driven world bounds → addFloorPlanPlane (handle)
//
// The caller toggles this hook on/off via the `enabled` flag.
// When `enabled` flips from false → true (or when the
// calibration / PDF changes), the hook tears down the old
// plane (if any), loads the new PDF, and places the plane.
// When `enabled` flips to false, or the hook unmounts, the
// plane is removed from the scene.
//
// The hook is render-safe: it uses an AbortController per
// effect cycle and a `cancelled` flag for cleanup guards.
//
// Wave 63: `opacity` (0..1) is applied when the plane is placed and
// pushed LIVE to the existing plane when it changes — the PDF is not
// re-rendered and the texture is not re-created.

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { loadPDF } from "@ff/viewer";
import type { PdfApi } from "@ff/viewer";
import { getPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { getPdfBlob } from "@ff/data/db/tables/pdfBlobs";
import { applyCalibration } from "@ff/data/calibration/similarity";
import type { CalibrationTransformParams } from "@ff/types";
import type { IfcViewerHandle } from "@ff/viewer-react";

/** Render scale for the PDF page → canvas texture. 2× gives
 *  crisp text at typical 3D zoom levels without blowing out
 *  texture memory (a 24×36 inch plan at 2× 72 DPI = 3456×5184 px,
 *  which is ~72 MB RGBA — acceptable for a single texture on a
 *  modern GPU). */
const PDF_RENDER_SCALE = 2;

/** Wave 63: default overlay opacity when the caller passes none. */
export const DEFAULT_FLOOR_PLAN_OVERLAY_OPACITY = 1;

export interface FloorPlanOverlayState {
  /** True while the PDF is loading / rendering. */
  loading: boolean;
  /** Non-null if the last load/placement failed. */
  error: Error | null;
  /** The plane id returned by addFloorPlanPlane, or null. */
  planeId: string | null;
}

/**
 * Drive a floor-plan overlay on a 3D viewer.
 *
 * @param viewerRef — imperative ref to the RIGHT <IfcViewer>.
 * @param pdfVersionId — the PDF version to render (from the Mapped
 *   PDFs sidebar). Null = "nothing to overlay".
 * @param calibration — the similarity transform + floor elevation
 *   for the selected PDF/floor combination. Null = no calibration
 *   data (e.g. PDF not mapped to any storey in this building).
 * @param enabled — whether the overlay is active. Toggled by the
 *   FloorPlanToggle component. Even if enabled, the hook is a
 *   no-op when pdfVersionId or calibration is null.
 * @param opacity — plane opacity 0..1 (default 1). Changing it only
 *   updates the material and requests a render.
 */
export function useFloorPlanOverlay(
  viewerRef: RefObject<IfcViewerHandle>,
  pdfVersionId: string | null,
  calibration: {
    transformParams: CalibrationTransformParams;
    floorZ: number;
  } | null,
  enabled: boolean,
  opacity: number = DEFAULT_FLOOR_PLAN_OVERLAY_OPACITY,
): FloorPlanOverlayState {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const planeIdRef = useRef<string | null>(null);
  // Read at placement time — NOT an effect dep of the load effect, so
  // an opacity change never reloads the PDF.
  const opacityRef = useRef(opacity);
  opacityRef.current = opacity;

  // Live opacity: update the existing plane's material in place.
  useEffect(() => {
    const id = planeIdRef.current;
    const handle = viewerRef.current;
    if (!id || !handle) return;
    handle.setFloorPlanPlaneOpacity?.(id, opacity);
    handle.requestRender?.("floor-plan-opacity");
  }, [opacity, viewerRef]);

  useEffect(() => {
    // Nothing to overlay — clean up any existing plane.
    if (!enabled || !pdfVersionId || !calibration) {
      const id = planeIdRef.current;
      if (id) {
        viewerRef.current?.removeFloorPlanPlane(id);
        planeIdRef.current = null;
      }
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const ac = new AbortController();

    const loadAndPlace = async () => {
      setLoading(true);
      setError(null);

      try {
        // 1. Get the PDF blob from Dexie.
        const version = await getPdfVersion(pdfVersionId);
        if (cancelled || ac.signal.aborted) return;
        if (!version) {
          throw new Error(`PDF version ${pdfVersionId} not found`);
        }
        const blob = await getPdfBlob(version.blobKey);
        if (cancelled || ac.signal.aborted) return;
        if (!blob) {
          throw new Error(`PDF blob not found for key ${version.blobKey}`);
        }

        // 2. Parse the PDF.
        const buf = await blob.arrayBuffer();
        if (cancelled || ac.signal.aborted) return;
        const api: PdfApi = await loadPDF(buf, {
          singlePage: false, // Accept multi-page; we always render page 1.
        });

        // 3. Render page 1 to an off-screen canvas.
        const canvas = document.createElement("canvas");
        const { promise, cancel } = await api.renderPage(
          canvas,
          1,
          PDF_RENDER_SCALE,
        );
        if (cancelled || ac.signal.aborted) {
          cancel();
          api.destroy();
          return;
        }
        try {
          await promise;
        } catch (renderErr) {
          api.destroy();
          throw renderErr;
        }

        // 4. Place the page with the full similarity transform.
        const { worldBounds, rotation } = computeOverlayPlacement(
          calibration.transformParams,
          api.width,
          api.height,
        );

        // 5. Place the plane in the viewer.
        const handle = viewerRef.current;
        if (!handle) {
          api.destroy();
          throw new Error("Viewer handle not available");
        }

        // Remove any old plane first (idempotent — safe to call
        // even if the previous id was already removed).
        const oldId = planeIdRef.current;
        if (oldId) {
          handle.removeFloorPlanPlane(oldId);
        }

        const newId = handle.addFloorPlanPlane(
          canvas,
          worldBounds,
          calibration.floorZ,
          // `rotation` only when non-zero: unrotated calls keep the
          // exact pre-rotation argument shape.
          rotation !== 0
            ? { opacity: opacityRef.current, rotation }
            : { opacity: opacityRef.current },
        );
        planeIdRef.current = newId;

        // 5. Clean up the pdf.js document — the texture now
        //    owns a copy of the canvas pixel data.
        api.destroy();

        if (!cancelled && !ac.signal.aborted) {
          setLoading(false);
        }
      } catch (err) {
        if (cancelled || ac.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.error("[useFloorPlanOverlay] failed:", err);
        setError(
          err instanceof Error ? err : new Error(String(err)),
        );
        setLoading(false);
      }
    };

    loadAndPlace();

    return () => {
      cancelled = true;
      ac.abort();
      const id = planeIdRef.current;
      if (id) {
        viewerRef.current?.removeFloorPlanPlane(id);
        planeIdRef.current = null;
      }
    };
  }, [enabled, pdfVersionId, calibration, viewerRef]);

  return {
    loading,
    error,
    planeId: planeIdRef.current,
  };
}

/**
 * Place the page with the FULL similarity transform (rotation included).
 *
 * The plane is the un-rotated page rectangle (scale * width x
 * scale * height) centred on the world image of the page centre,
 * plus the calibration's rotation, which the viewer applies about
 * that centre. With rotation 0 the rectangle equals the old
 * axis-aligned bounds of the transformed corners. (Using the corner
 * AABB with a rotated page stretched the texture over a rectangle
 * that is not the page.)
 */
export function computeOverlayPlacement(
  params: CalibrationTransformParams,
  pdfWidth: number,
  pdfHeight: number,
): {
  worldBounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  rotation: number;
} {
  const centre = applyCalibration(params, { x: pdfWidth / 2, y: pdfHeight / 2 });
  const halfW = (params.scale * pdfWidth) / 2;
  const halfD = (params.scale * pdfHeight) / 2;
  return {
    worldBounds: {
      minX: centre.x - halfW,
      maxX: centre.x + halfW,
      minZ: centre.z - halfD,
      maxZ: centre.z + halfD,
    },
    rotation: params.rotation,
  };
}
