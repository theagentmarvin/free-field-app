/**
 * Compare revisions — shared contract between the diff engine
 * (`compare/engine/*`) and the UI (`compare/ui/*`, store, viewer).
 * Spec: docs/specs/documents-compare-revisions.md
 *
 * Coordinate spaces:
 *  - "raster px": pixels of the normalised comparison raster (Base page box
 *    rendered at `scale = dpi / 72`, possibly capped).
 *  - "page pt": PDF points of the Base page at scale 1 (origin top-left,
 *    y down — same as pdf.js viewport space at scale 1).
 */

export type CompareMode = "side-by-side" | "overlay" | "changes";

export type SensitivityPreset = "vector" | "scanned" | "fine";

export type HighlightStyle = "cloud" | "box";

export type ChangeKind = "added" | "removed" | "modified";

/** One side of a comparison. */
export interface CompareSide {
  pdfFileId: string;
  pdfVersionId: string;
  /** 1-based page number. */
  page: number;
}

/** Low-level diff thresholds (raster px units). */
export interface DiffThresholds {
  /** 0..255 luminance delta for a pixel to count as different. */
  colorThreshold: number;
  /** Neighbourhood radius tolerated for shifts / anti-aliasing (0 = off). */
  proximityPx: number;
  /** Grid cell edge in raster px. */
  gridSize: number;
  /** Diff pixels a cell needs to be flagged. */
  minPixelsPerCell: number;
  /** Flagged-cell components closer than this many cells are merged. */
  mergeDistance: number;
  /** Ignore a band this wide (raster px) around the page border. */
  marginPx: number;
}

export interface CompareSettings {
  preset: SensitivityPreset;
  /**
   * 72 (standard), 144 (high) or "auto" (default): 144 DPI when the Base raster
   * fits the pixel cap, otherwise the highest DPI that fits.
   */
  dpi: 72 | 144 | "auto";
  marginPx: number;
  autoAlign: boolean;
  /** Manual nudge applied to the Revision, in Base page points. */
  nudgePt: { x: number; y: number };
  highlightStyle: HighlightStyle;
  /** Explicit overrides; when omitted the preset values apply. */
  thresholds?: Partial<DiffThresholds>;
}

export const DEFAULT_COMPARE_SETTINGS: CompareSettings = {
  preset: "vector",
  dpi: "auto",
  marginPx: 0,
  autoAlign: true,
  nudgePt: { x: 0, y: 0 },
  highlightStyle: "cloud",
};

/** Axis-aligned box in Base page points. */
export interface PtBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChangeRegion {
  /** Stable within one result, 1-based display order ("#1", "#2", ...). */
  id: number;
  kind: ChangeKind;
  bbox: PtBox;
  /** Diff pixels inside the region (raster px). */
  diffPixels: number;
  addedPixels: number;
  removedPixels: number;
}

/** A rasterised, normalised page ready for diffing / display. */
export interface RasterPage {
  width: number;
  height: number;
  /** RGBA, length = width * height * 4. */
  data: Uint8ClampedArray;
}

export interface CompareResult {
  /** Raster size used for the diff (both pages normalised to this). */
  width: number;
  height: number;
  /** raster px per page pt. */
  scale: number;
  /** Base page size in points. */
  pageWidthPt: number;
  pageHeightPt: number;
  /** Offset applied to the Revision (auto-align + nudge), in page pt. */
  offsetPt: { x: number; y: number };
  /** Revision was rescaled to the Base page box by this factor (1 = same size). */
  revisionScale: number;
  /**
   * True when an explicitly requested DPI was lowered to fit the pixel budget
   * (or "auto" could not even reach 72 DPI). Auto picking a lower DPI is not flagged.
   */
  downscaled: boolean;
  /** Effective DPI of the raster (scale * 72). */
  dpiUsed?: number;
  regions: ChangeRegion[];
  /** Total diff pixels (added + removed). */
  diffPixels: number;
  /**
   * Per-pixel classification at raster size: 0 = same/blank,
   * 1 = ink in both, 2 = ink only in Base (removed), 3 = ink only in Revision (added).
   * The UI paints the overlay from this without re-diffing.
   */
  classes: Uint8Array;
  /** Base raster (width x height) — what the UI shows in the Base pane. */
  base: RasterPage;
  /**
   * Revision raster already normalised into the Base frame (rescaled +
   * offset applied), same width x height — shown in the Revision pane.
   */
  revision: RasterPage;
  durationMs: number;
  /**
   * The Revision's height ratio differs from its width ratio by more than 2 %
   * (different aspect); it was still scaled by width only.
   */
  aspectMismatch?: boolean;
}

export type CompareStage = "loading" | "rendering" | "aligning" | "comparing" | "done";

export interface CompareProgress {
  stage: CompareStage;
  /** 0..1 within the whole job, best effort. */
  fraction: number;
}

/**
 * Engine entry point implemented by `compare/engine/runCompare.ts`.
 * Loads both versions (via getPdfVersion/getPdfBlob), rasterises, aligns,
 * diffs (worker when available) and returns the result. Abortable.
 */
export type RunCompare = (
  base: CompareSide,
  revision: CompareSide,
  settings: CompareSettings,
  opts?: { signal?: AbortSignal; onProgress?: (p: CompareProgress) => void },
) => Promise<CompareResult>;
