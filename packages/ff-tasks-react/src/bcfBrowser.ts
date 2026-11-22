import type { BcfBinary } from "@ff/tasks";

/**
 * Browser-only helpers for the BCF export (kept out of bcfExport.ts so
 * that file stays pure/testable): bytes from a resolved photo URL, image
 * size, and the JPEG → PNG re-encode BCF 2.1 snapshots need.
 */

/** Long side of an exported snapshot, px. */
export const BCF_MAX_SNAPSHOT_SIDE = 1500;

async function measure(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close?.();
    return size;
  } catch {
    return null;
  }
}

/** URL (data: or https:) → bytes. Null when the fetch fails. */
export async function fetchBinaryFromUrl(
  url: string,
  opts: { mime?: string; measure?: boolean } = {},
): Promise<BcfBinary | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  const mime = blob.type && blob.type.startsWith("image/") ? blob.type : (opts.mime ?? "image/jpeg");
  const out: BcfBinary = { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
  if (opts.measure) {
    const size = await measure(blob);
    if (size) Object.assign(out, size);
  }
  return out;
}

/** Re-encode an image to PNG, downscaling the long side to ≤ 1500 px. */
export async function convertToPng(b: BcfBinary): Promise<BcfBinary> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return b;
  const bmp = await createImageBitmap(new Blob([b.bytes as BlobPart], { type: b.mime }));
  const scale = Math.min(1, BCF_MAX_SNAPSHOT_SIDE / Math.max(bmp.width, bmp.height));
  const width = Math.max(1, Math.round(bmp.width * scale));
  const height = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) {
    bmp.close?.();
    return b;
  }
  g.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!png) return b;
  return { bytes: new Uint8Array(await png.arrayBuffer()), mime: "image/png", width, height };
}
