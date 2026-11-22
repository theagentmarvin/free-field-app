import type { ChangeRegion, CompareResult, CompareSide, RunCompare } from "../../src/compare/types";

export const W = 40;
export const H = 30;

export function region(id: number, kind: ChangeRegion["kind"], x = 4 * id, y = 3 * id, w = 12, h = 8): ChangeRegion {
  return {
    id,
    kind,
    bbox: { x, y, w, h },
    diffPixels: 10 * id,
    addedPixels: kind === "added" ? 10 * id : 0,
    removedPixels: kind === "removed" ? 10 * id : 0,
  };
}

export function makeResult(over: Partial<CompareResult> = {}): CompareResult {
  const classes = new Uint8Array(W * H);
  classes[0] = 1;
  classes[1] = 2;
  classes[2] = 3;
  const page = () => ({ width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(255) });
  return {
    width: W,
    height: H,
    scale: 1,
    pageWidthPt: W,
    pageHeightPt: H,
    offsetPt: { x: 0, y: 0 },
    revisionScale: 1,
    downscaled: false,
    regions: [region(1, "added"), region(2, "removed"), region(3, "modified")],
    diffPixels: 60,
    classes,
    base: page(),
    revision: page(),
    durationMs: 5,
    ...over,
  };
}

export const sideA: CompareSide = { pdfFileId: "f1", pdfVersionId: "f1-v1", page: 1 };
export const sideB: CompareSide = { pdfFileId: "f1", pdfVersionId: "f1-v2", page: 1 };

export const fakeRunner = (result = makeResult()): RunCompare => async () => result;

export function installCanvasStub(): () => void {
  const original = HTMLCanvasElement.prototype.getContext;
  const originalImageData = (globalThis as { ImageData?: unknown }).ImageData;
  HTMLCanvasElement.prototype.getContext = (() => ({
    putImageData: () => {},
    drawImage: () => {},
    fillRect: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  (globalThis as { ImageData?: unknown }).ImageData = class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  };
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
    (globalThis as { ImageData?: unknown }).ImageData = originalImageData;
  };
}
