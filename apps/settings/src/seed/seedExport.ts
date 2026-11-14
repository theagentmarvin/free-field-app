// src/seed/seedExport.ts
//
// Wave 56 — pre-parsed demo seed RE-EXPORT utility (dev tool).
//
// Triggered by `?ff-export-seed=1` on the settings app (demo mode
// only, checked once at boot). Reads the same tables the loader
// injects plus every `fragBlobs`/`pdfBlobs` row, then produces a ZIP
// download with the exact §1 bundle layout:
//
//   manifest.json                 (format "free-field-demo-seed" v1,
//                                  `__blob` markers, no inline bytes)
//   blobs/fragBlobs/<key>         (.frag binaries)
//   blobs/pdfBlobs/<key>          (raw PDFs)
//
// No UI beyond the automatic download; no cloud writes. `console.info`
// prints a summary (row counts per table + blob count + total bytes).

import { isDemoAuth } from "@ff/auth";
import { db } from "@ff/data/db/database";
import JSZip from "jszip";

/** Data tables written to `manifest.tables`, in loader parent-before-child order. */
const TABLE_NAMES = [
  "projects",
  "buildings",
  "ifcFiles",
  "pdfFiles",
  "ifcVersions",
  "pdfVersions",
  "storeys",
  "extractedStoreys",
  "buildingLevelSelection",
  "pdfFolders",
  "pdfFolderAssignments",
  "propertyCatalog",
  "calibrations",
] as const;

type SeedTableName = (typeof TABLE_NAMES)[number];

/**
 * Run the re-export when the `?ff-export-seed=1` flag is present.
 * Safe to call on every boot — returns immediately when the flag is
 * absent or the app is not in demo mode.
 */
export async function exportDemoSeedIfRequested(): Promise<
  "exported" | "skipped"
> {
  if (!isDemoAuth()) return "skipped";
  if (typeof window === "undefined") return "skipped";

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return "skipped";
  }
  if (params.get("ff-export-seed") !== "1") return "skipped";

  try {
    await buildAndDownload();
    return "exported";
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[seedExport] re-export failed:", err);
    return "skipped";
  }
}

/**
 * Build the ZIP in-memory and trigger the browser download.
 */
async function buildAndDownload(): Promise<void> {
  const zip = new JSZip();
  const blobRoot = zip.folder("blobs");
  if (!blobRoot) throw new Error("seedExport: could not create blobs/ folder");
  const fragFolder = blobRoot.folder("fragBlobs");
  const pdfFolder = blobRoot.folder("pdfBlobs");
  if (!fragFolder || !pdfFolder) {
    throw new Error("seedExport: could not create blob sub-folders");
  }

  // ── Data tables (row snapshots, Blob fields absent by construction) ──
  const counts: Record<SeedTableName, number> = {} as Record<
    SeedTableName,
    number
  >;
  const tables = {} as Record<SeedTableName, unknown[]>;

  for (const name of TABLE_NAMES) {
    const rows = (await db[name].toArray()) as unknown[];
    tables[name] = rows;
    counts[name] = rows.length;
  }

  // ── Blobs (bytes under blobs/<table>/<key>) ──
  const fragRows = await db.fragBlobs.toArray();
  const pdfRows = await db.pdfBlobs.toArray();

  const fragRefs: Array<{ key: string; __blob: boolean }> = [];
  const pdfRefs: Array<{ key: string; __blob: boolean }> = [];
  let totalBytes = 0;

  for (const row of fragRows) {
    fragRefs.push({ key: row.key, __blob: true });
    fragFolder.file(row.key, row.blob);
    totalBytes += row.blob.size;
  }
  for (const row of pdfRows) {
    pdfRefs.push({ key: row.key, __blob: true });
    pdfFolder.file(row.key, row.bytes);
    totalBytes += row.bytes.size;
  }

  const manifest = {
    format: "free-field-demo-seed",
    version: 1,
    capturedAt: new Date().toISOString(),
    tables,
    fragBlobs: fragRefs,
    pdfBlobs: pdfRefs,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 1));

  const archive = await zip.generateAsync({ type: "blob" });
  triggerDownload(
    archive,
    `ff-demo-seed-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
  );

  // eslint-disable-next-line no-console
  console.info(
    "[seedExport] re-export complete:",
    counts,
    `{ blobs: ${fragRows.length + pdfRows.length}, totalBytes: ${totalBytes} }`,
  );
}

/** Create an <a download> and click it (the only "UI" for this tool). */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick so the click handler has consumed it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}