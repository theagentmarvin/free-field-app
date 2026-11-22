// apps/linkview/src/linkviewTaskLocation.ts
//
// LinkView dual location (creation side). A task created in LinkView
// stores BOTH where it is on the plan and where it is in 3D. The 3D tap
// (the shared surface's tap-to-create) already yields `location.bim`; this
// adds the matching `location.pdf` by projecting the tapped world point
// through the calibration of the plan open in the left pane, and stamps
// `location.origin = 'linkview'`. Pure: no viewer, no storage.

import { invertCalibration } from "@ff/data/calibration/similarity";
import {
  LINKVIEW_ORIGIN,
  pdfPinLocation,
  type CalibrationLike,
  type SnapshotThumbResult,
} from "@ff/tasks-react";

/** The task location shape (@ff/firestore TaskLocation, via the tasks-react seam). */
type TaskLocation = SnapshotThumbResult["location"];

/** What the open plan contributes (a slice of LinkviewApp's overlay calibration). */
export interface LinkviewPlanContext {
  pdfFileId: string;
  /** PdfVersionRecord.id of the plan open in the left pane */
  versionId: string;
  calibration: CalibrationLike;
  pageWidth: number;
  pageHeight: number;
}

export interface LinkviewLocation {
  location: TaskLocation;
  /** the pin, normalized over the page (drives the plan snapshot crop) */
  uv: [number, number];
}

/**
 * Add the plan pin + origin to a 3D location. Returns null (the task is
 * then an ordinary 3D task) when there is no 3D placement, or the tapped
 * point falls outside the open plan's page (no honest 2D position exists).
 * Calibrations belong to page 1, so the pin is always on page 1.
 */
export function linkviewLocationFromBim(
  location: TaskLocation,
  plan: LinkviewPlanContext,
): LinkviewLocation | null {
  const wp = location.bim?.worldPoint;
  if (!wp || wp.length !== 3 || !wp.every((n: number) => Number.isFinite(n))) return null;
  if (!(plan.pageWidth > 0) || !(plan.pageHeight > 0)) return null;
  if (!(plan.calibration.transformParams.scale > 0)) return null;
  // Back-project to page points FIRST: normalizing to uv clamps, which
  // would hide a point that is off the page.
  const pt = invertCalibration(plan.calibration.transformParams, { x: wp[0], z: wp[2] });
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  if (pt.x < 0 || pt.x > plan.pageWidth || pt.y < 0 || pt.y > plan.pageHeight) return null;
  const uv: [number, number] = [pt.x / plan.pageWidth, pt.y / plan.pageHeight];
  const pin = pdfPinLocation(plan.pdfFileId, 1, uv, plan.calibration, plan.versionId).pdf;
  if (!pin) return null;
  return {
    location: {
      ...location,
      storeyName: location.storeyName ?? plan.calibration.storeyName,
      origin: LINKVIEW_ORIGIN,
      pdf: pin,
    },
    uv,
  };
}
