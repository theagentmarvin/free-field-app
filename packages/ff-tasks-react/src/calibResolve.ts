import { calibrationDocId } from "@ff/firestore";
import { UNCALIBRATED_CALIB_ID } from "@ff/types";

/**
 * w75 — `location.pdf.calibId` contract.
 *
 * Canonical value on newly written pins: `calibrationDocId(pdfFileId,
 * storeyName)` (the synced Firestore doc id, identical on every device).
 * Readers go through {@link resolveCalibration} so legacy pins (local
 * Dexie uuid) and raw-form ids keep working without a data migration.
 */

/** The slice of a calibration row the resolver needs. */
export interface ResolvableCalibration {
  id: string;
  storeyName: string;
  /** Present on Dexie rows; when absent the pin's pdfFileId is assumed. */
  pdfFileId?: string;
}

/** The slice of a pin the resolver needs (PdfPin / TaskLocation.pdf both fit). */
export interface CalibPinRef {
  calibId: string;
  pdfFileId: string;
  /** `task.location.storeyName`, used as the last-resort lookup key. */
  storeyName?: string | null;
}

/** Canonical `calibId` for a pin on `(pdfFileId, storeyName)`. */
export function canonicalCalibId(pdfFileId: string, storeyName: string): string {
  return calibrationDocId(pdfFileId, storeyName);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * Resolve the calibration a pin trusts from `calibrations`, tolerantly:
 *  a. a row whose `id` equals `calibId` (legacy local uuid, same device);
 *  b. `${pdfFileId}__${encodeURIComponent(storey)}` -> decode, look up by
 *     (pdfFileId, storeyName);
 *  c. raw `${pdfFileId}__${storeyName}` (not encoded), same lookup;
 *  d. the pin's own `pdfFileId` + `storeyName`.
 * The `UNCALIBRATED_CALIB_ID` sentinel never resolves (drift rule relies
 * on that). Returns null when nothing matches.
 */
export function resolveCalibration<T extends ResolvableCalibration>(
  pin: CalibPinRef,
  calibrations: readonly T[]
): T | null {
  const { calibId, pdfFileId } = pin;
  if (!calibId || calibId === UNCALIBRATED_CALIB_ID) return null;

  const byId = calibrations.find((c) => c.id === calibId);
  if (byId) return byId;

  const byStorey = (storey: string): T | null =>
    calibrations.find(
      (c) => c.storeyName === storey && (c.pdfFileId ?? pdfFileId) === pdfFileId
    ) ?? null;

  const prefix = `${pdfFileId}__`;
  if (calibId.startsWith(prefix)) {
    const rest = calibId.slice(prefix.length);
    const decoded = safeDecode(rest);
    if (decoded !== null) {
      const hit = byStorey(decoded);
      if (hit) return hit;
    }
    const raw = byStorey(rest);
    if (raw) return raw;
  }

  if (pin.storeyName) return byStorey(pin.storeyName);
  return null;
}
