// src/bundle/parseBundle.ts
//
// Open a `.ffbundle` (zip), validate its manifest and expose its entries.
// Entry bytes are read lazily so a large bundle is never fully inflated
// at once.

import JSZip from "jszip";
import { z } from "zod";

import type { BundleManifest } from "./ffbundleTypes";

export const BUNDLE_SCHEMA_ID = "freefield.bundle/1";

/** Largest manifest.json we inflate (guards against zip bombs). */
export const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;

// ── Untrusted-import limits (zip-bomb / memory-DoS guards) ─────────────
//
// Checked against the zip central directory BEFORE any entry is inflated.
// Chosen so real projects never hit them: a large 30-sheet sample bundle is 41 MB
// (1 IFC + 30 PDFs); real IFCs run to hundreds of MB. All are constants so
// a deployment can tune them.

/** Largest .ffbundle file we will open at all (2 GiB: the ArrayBuffer ceiling). */
export const MAX_BUNDLE_FILE_BYTES = 2 * 1024 * 1024 * 1024;
/** Maximum number of entries in the archive. */
export const MAX_BUNDLE_ENTRIES = 5000;
/** Maximum declared uncompressed size of any single entry (1 GiB). */
export const MAX_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
/** Maximum declared uncompressed size of all entries together (2 GiB). */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
/** Entries larger than this are subject to the compression-ratio check. */
export const RATIO_CHECK_MIN_BYTES = 10 * 1024 * 1024;
/** Maximum uncompressed:compressed ratio for entries above RATIO_CHECK_MIN_BYTES. */
export const MAX_COMPRESSION_RATIO = 100;

export class BundleFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleFormatError";
  }
}

const num = z.number().finite();
const bbox4 = z.tuple([num, num, num, num]);
const controlPoint = z.object({
  pdfX: num,
  pdfY: num,
  modelX: num,
  modelY: num,
});

const viewportSchema = z
  .object({
    id: z.string(),
    viewName: z.string().optional().default(""),
    viewType: z.string().optional().default(""),
    scale: num.optional().default(1),
    modelId: z.string().nullish(),
    storeyName: z.string().nullish(),
    primary: z.boolean().optional().default(false),
    pdfRegion: bbox4.optional(),
    pdfToModel: z.tuple([num, num, num, num, num, num]).nullish(),
    controlPoints: z.array(controlPoint).nullish(),
  })
  .passthrough();

const storeySchema = z
  .object({ name: z.string(), elevation: num.optional().default(0) })
  .passthrough();

const modelSchema = z
  .object({
    id: z.string(),
    file: z.string().min(1),
    name: z.string().optional(),
    storeys: z.array(storeySchema).default([]),
  })
  .passthrough();

const sheetSchema = z
  .object({
    id: z.string(),
    number: z.string(),
    name: z.string().default(""),
    file: z.string().min(1),
    data: z.string().optional(),
    page: z.object({ widthPt: num, heightPt: num }).optional(),
    viewports: z.array(viewportSchema).default([]),
  })
  .passthrough();

export const manifestSchema = z
  .object({
    schema: z.literal(BUNDLE_SCHEMA_ID),
    exportedAt: z.string().optional(),
    project: z
      .object({ name: z.string(), number: z.string().optional() })
      .passthrough(),
    models: z.array(modelSchema),
    sheets: z.array(sheetSchema),
    elementsFile: z.string().optional(),
  })
  .passthrough();

export interface ParsedBundle {
  manifest: BundleManifest;
  /** All file entries in the archive (no directories). */
  entries: string[];
  has(path: string): boolean;
  readBytes(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}

function normalise(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "");
}

function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "manifest"}: ${i.message}`)
    .join("; ");
}

/** Validate an already-decoded manifest object. */
export function validateManifest(raw: unknown): BundleManifest {
  if (
    raw &&
    typeof raw === "object" &&
    (raw as { schema?: unknown }).schema !== BUNDLE_SCHEMA_ID
  ) {
    throw new BundleFormatError(
      `Unsupported bundle schema "${String((raw as { schema?: unknown }).schema)}" (expected ${BUNDLE_SCHEMA_ID})`,
    );
  }
  const res = manifestSchema.safeParse(raw);
  if (!res.success) {
    throw new BundleFormatError(`Invalid bundle manifest: ${formatIssues(res.error)}`);
  }
  return res.data as unknown as BundleManifest;
}

const mb = (n: number): string => `${Math.round(n / 1048576)} MB`;

/**
 * Reject archives whose central-directory metadata is hostile, before any
 * entry is inflated. JSZip exposes the declared sizes only on a private
 * `_data` field, so the read is defensive: entries without readable
 * metadata are skipped (the manifest and per-read guards still apply).
 */
export function assertSafeArchive(zip: JSZip): void {
  const entries = Object.values(zip.files);
  if (entries.length > MAX_BUNDLE_ENTRIES) {
    throw new BundleFormatError(
      `This bundle has too many files (${entries.length}; the limit is ${MAX_BUNDLE_ENTRIES}). It looks malformed or unsafe to import.`,
    );
  }
  let total = 0;
  for (const e of entries) {
    if (e.dir) continue;
    const d = (e as unknown as { _data?: { uncompressedSize?: unknown; compressedSize?: unknown } })._data;
    const un = d?.uncompressedSize;
    const co = d?.compressedSize;
    if (typeof un !== "number" || !Number.isFinite(un)) continue;
    if (un > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new BundleFormatError(
        `"${e.name}" is too large to import (${mb(un)} uncompressed; the limit per file is ${mb(MAX_ENTRY_UNCOMPRESSED_BYTES)}).`,
      );
    }
    if (un > RATIO_CHECK_MIN_BYTES && typeof co === "number" && co > 0 && un / co > MAX_COMPRESSION_RATIO) {
      throw new BundleFormatError(
        `"${e.name}" has a suspicious compression ratio (${Math.round(un / co)}:1; the limit is ${MAX_COMPRESSION_RATIO}:1). The bundle may be a decompression bomb, so it was not imported.`,
      );
    }
    total += un;
    if (total > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new BundleFormatError(
        `This bundle expands to more than ${mb(MAX_TOTAL_UNCOMPRESSED_BYTES)}, which is over the import limit.`,
      );
    }
  }
}

export async function parseBundle(
  input: Blob | ArrayBuffer | Uint8Array,
): Promise<ParsedBundle> {
  const inputSize = input instanceof Uint8Array || input instanceof ArrayBuffer
    ? input.byteLength
    : (input as Blob).size;
  if (inputSize > MAX_BUNDLE_FILE_BYTES) {
    throw new BundleFormatError(
      `This bundle file is too large to import (${mb(inputSize)}; the limit is ${mb(MAX_BUNDLE_FILE_BYTES)}).`,
    );
  }
  let zip: JSZip;
  try {
    const data =
      typeof Blob !== "undefined" && input instanceof Blob
        ? await input.arrayBuffer()
        : input;
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new BundleFormatError("Not a valid bundle: the file is not a readable zip archive");
  }
  assertSafeArchive(zip);
  const files = new Map<string, JSZip.JSZipObject>();
  zip.forEach((path, obj) => {
    if (!obj.dir) files.set(normalise(path), obj);
  });
  const manifestEntry = files.get("manifest.json");
  if (!manifestEntry) throw new BundleFormatError("Not a FreeField bundle: manifest.json is missing");
  const declared = (manifestEntry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > MAX_MANIFEST_BYTES) {
    throw new BundleFormatError(
      `manifest.json is too large (${Math.round(declared / 1048576)} MB, limit ${MAX_MANIFEST_BYTES / 1048576} MB)`,
    );
  }
  let raw: unknown;
  try {
    const text = await manifestEntry.async("string");
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new BundleFormatError("manifest.json is too large");
    }
    raw = JSON.parse(text);
  } catch (e) {
    if (e instanceof BundleFormatError) throw e;
    throw new BundleFormatError("manifest.json is not valid JSON");
  }
  const manifest = validateManifest(raw);

  const get = (path: string): JSZip.JSZipObject => {
    const e = files.get(normalise(path));
    if (!e) throw new BundleFormatError(`Bundle entry not found: ${path}`);
    return e;
  };
  return {
    manifest,
    entries: [...files.keys()],
    has: (p) => files.has(normalise(p)),
    readBytes: async (p) => get(p).async("uint8array"),
    readText: async (p) => get(p).async("string"),
  };
}
