// apps/documents/src/compare/csv.ts

import type { ChangeRegion } from "./types";

export const CSV_HEADER = "id,kind,x_pt,y_pt,w_pt,h_pt,diff_pixels,reviewed";

const r2 = (n: number) => String(Math.round(n * 100) / 100);

export function regionsToCsv(regions: readonly ChangeRegion[], reviewed: readonly number[]): string {
  const done = new Set(reviewed);
  const lines = regions.map((r) =>
    [
      r.id,
      r.kind,
      r2(r.bbox.x),
      r2(r.bbox.y),
      r2(r.bbox.w),
      r2(r.bbox.h),
      r.diffPixels,
      done.has(r.id) ? "true" : "false",
    ].join(","),
  );
  return [CSV_HEADER, ...lines].join("\n") + "\n";
}

/** Browser download of a Blob; a no-op where object URLs are unavailable. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
