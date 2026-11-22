// src/bundle/importBundle.ts
//
// Orchestrates a FreeField bundle import:
//   1. choose / create the target building
//   2. ingest every IFC model (manifest order)
//   3. read the building's base-model coordinate shift from its .frag
//   4. import every sheet PDF (`<number> - <name>.pdf`), deduped
//   5. auto-calibrate each primary plan viewport against its storey
//
// All side effects go through injectable `deps`, so the flow is
// testable without web-ifc, pdf.js or a worker.

import { ingestIfc as defaultIngestIfc } from "@ff/data/hooks";
import { db } from "@ff/data/db/database";
import {
  createBuilding,
  findBuildingByName,
  updateBuilding,
} from "@ff/data/db/tables/buildings";
import {
  createCalibration,
  getCalibrationForPdfAndStorey,
  updateCalibration,
} from "@ff/data/db/tables/calibrations";
import { setExtracted } from "@ff/data/db/tables/extractedStoreys";
import { getLatestVersion } from "@ff/data/db/tables/ifcVersions";
import { findIfcFileByName, listIfcFiles } from "@ff/data/db/tables/ifcFiles";
import { getLatestPdfVersion } from "@ff/data/db/tables/pdfVersions";
import { findPdfFileByName } from "@ff/data/db/tables/pdfFiles";
import { listStoreysByVersion } from "@ff/data/db/tables/storeys";
import type { IfcFileRecord, StoreyRecord } from "@ff/types";

import {
  fullContentHash,
  importPdfFile,
  type LoadPdfResult,
} from "../hooks/pdfImport";
import {
  buildCalibration,
  CalibrationInputError,
  type BaseShift,
} from "./bundleCalibration";
import { readVersionShift } from "./fragCoordinates";
import type {
  ControlPoint,
  SheetEntry,
  ViewportEntry,
} from "./ffbundleTypes";
import type { ParsedBundle } from "./parseBundle";

export interface BundleProgress {
  phase: "model" | "sheet" | "calibration" | "done";
  message: string;
  current?: number;
  total?: number;
}

/** "imported" = a NEW PDF; "newVersion" = a new version of an existing PDF. */
export type SheetStatus = "imported" | "newVersion" | "unchanged" | "skipped" | "failed";
export type ItemChange = "new" | "newVersion" | "unchanged";

export interface SheetOutcome {
  number: string;
  name: string;
  status: SheetStatus;
  reason?: string;
  pdfFileId?: string;
  versionId?: string;
}

export interface ModelOutcome {
  id: string;
  file: string;
  status: "imported" | "failed";
  /** For imported models: new file, new version of an existing file, or identical bytes. */
  change?: ItemChange;
  versionId?: string;
  storeyNames: string[];
  reason?: string;
}

export interface ImportTimings {
  /** IFC conversion + storage of all models. */
  modelsMs: number;
  /** Base shift read from the converted fragment. */
  baseMs: number;
  /** PDF parse + storage of all sheets. */
  pdfsMs: number;
  /** Calibration math and writes of all sheets. */
  calibrationsMs: number;
}

const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

export interface ImportReport {
  buildingId: string;
  buildingName: string;
  createdBuilding: boolean;
  models: ModelOutcome[];
  sheets: SheetOutcome[];
  calibrationsCreated: number;
  calibrationsUpdated: number;
  warnings: string[];
  /** Wall-clock milliseconds per phase. */
  timings: ImportTimings;
  /** Version of the last imported/unchanged sheet PDF (to auto-open). */
  lastPdfVersionId: string | null;
}

export interface ImportBundleDeps {
  ingestIfc: typeof defaultIngestIfc;
  importPdf: (
    file: File,
    buildingId: string,
    opts?: { contentHash?: string },
  ) => Promise<LoadPdfResult>;
  readShift: (versionId: string) => Promise<BaseShift>;
}

export interface ImportBundleOptions {
  bundle: ParsedBundle;
  projectId: string;
  /** Currently selected building; when null one is created from the project name. */
  buildingId?: string | null;
  onProgress?: (p: BundleProgress) => void;
  signal?: AbortSignal;
  deps?: Partial<ImportBundleDeps>;
}

const DEFAULT_DEPS: ImportBundleDeps = {
  ingestIfc: defaultIngestIfc,
  importPdf: importPdfFile,
  readShift: readVersionShift,
};

/** Bundle-relative basename (`models/arch.ifc` -> `arch.ifc`). */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

const MAX_NAME_PART = 80;

/** Control / path-hostile characters replaced, trailing dots and spaces dropped, length capped. */
export function sanitizeNamePart(s: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f/:*?"<>|]/g, "_").trim().replace(/[. ]+$/, "");
  return cleaned.slice(0, MAX_NAME_PART).trim();
}

/** `<number> - <name>.pdf`; an empty number falls back to the sheet id. */
export function sheetPdfName(
  sheet: Pick<SheetEntry, "number" | "name">,
  fallbackId = "sheet",
): string {
  const number = sanitizeNamePart(sheet.number) || sanitizeNamePart(fallbackId) || "sheet";
  const name = sanitizeNamePart(sheet.name);
  return name ? `${number} - ${name}.pdf` : `${number}.pdf`;
}

/**
 * One distinct PDF name per manifest sheet. Sheets whose names collide after
 * sanitising (or share number and title) get " (2)", " (3)" ... so they never
 * merge into one PDF file as versions of each other.
 */
export function assignSheetPdfNames(
  sheets: ReadonlyArray<Pick<SheetEntry, "id" | "number" | "name">>,
  /** Names already bound to a sheet by an earlier import (null = none): kept, so the sheet becomes a new VERSION. */
  fixed: ReadonlyArray<string | null> = [],
): Array<{ name: string; renamedFrom: string | null }> {
  const used = new Set<string>();
  for (const n of fixed) if (n) used.add(n.toLowerCase());
  return sheets.map((s, i) => {
    const keep = fixed[i];
    if (keep) return { name: keep, renamedFrom: null };
    const base = sheetPdfName(s, s.id);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) {
      name = base.replace(/\.pdf$/, ` (${n}).pdf`);
    }
    used.add(name.toLowerCase());
    return { name, renamedFrom: name === base ? null : base };
  });
}

/**
 * The building's base model, exactly as the viewer picks it: files are
 * listed by name (locale order) and the first one that has a version
 * wins.
 */
export function pickBaseIfcFile<T extends Pick<IfcFileRecord, "name" | "id">>(
  files: readonly T[],
  hasVersion: (f: T) => boolean = () => true,
): T | undefined {
  return [...files]
    .sort((a, b) => a.name.localeCompare(b.name))
    .find(hasVersion);
}

/**
 * Two calibration control points for a viewport. Uses the manifest's
 * `controlPoints`; falls back to the viewport crop corners pushed
 * through `pdfToModel`.
 */
export function controlPointsFor(vp: ViewportEntry): ControlPoint[] | null {
  if (vp.controlPoints && vp.controlPoints.length >= 2) {
    return vp.controlPoints.slice(0, 2);
  }
  if (!vp.pdfToModel || !vp.pdfRegion) return null;
  const [a, b, c, d, e, f] = vp.pdfToModel;
  const [x0, y0, x1, y1] = vp.pdfRegion;
  const at = (px: number, py: number): ControlPoint => ({
    pdfX: px,
    pdfY: py,
    modelX: a * px + b * py + c,
    modelY: d * px + e * py + f,
  });
  return [at(x0, y0), at(x1, y1)];
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Import cancelled", "AbortError");
}

/** building.metadata key: which building item each manifest model / sheet became (for versioning). */
export const BUNDLE_INDEX_KEY = "bundleIndex";

export interface BundleIndex {
  models: Array<{ id: string; ifcName: string }>;
  sheets: Array<{ id: string; number: string; pdfName: string }>;
}

function readIndex(meta: unknown): BundleIndex {
  const v = (meta as Record<string, unknown> | undefined)?.[BUNDLE_INDEX_KEY] as Partial<BundleIndex> | undefined;
  return {
    models: Array.isArray(v?.models) ? v!.models!.filter((x) => x && typeof x.ifcName === "string") : [],
    sheets: Array.isArray(v?.sheets) ? v!.sheets!.filter((x) => x && typeof x.pdfName === "string") : [],
  };
}

/** building.metadata key holding [bx, by, bz] of the base model at import time. */
export const BASE_SHIFT_KEY = "bundleBaseShift";

function isShift(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

export async function importBundle(
  opts: ImportBundleOptions,
): Promise<ImportReport> {
  const { bundle, projectId, onProgress, signal } = opts;
  const deps: ImportBundleDeps = { ...DEFAULT_DEPS, ...opts.deps };
  const { manifest } = bundle;
  const warnings: string[] = [];

  // 1. Building
  let buildingId = opts.buildingId ?? null;
  let buildingName = manifest.project.name.trim() || "Imported project";
  let createdBuilding = false;
  if (buildingId) {
    const b = await db.buildings.get(buildingId);
    if (b) buildingName = b.name;
    else buildingId = null;
  }
  if (!buildingId) {
    const existing = await findBuildingByName(projectId, buildingName);
    if (existing) {
      buildingId = existing.id;
    } else {
      buildingId = (await createBuilding({ projectId, name: buildingName, metadata: {} })).id;
      createdBuilding = true;
    }
  }
  const targetBuildingId: string = buildingId;
  const index = readIndex((await db.buildings.get(targetBuildingId))?.metadata);
  const newIndex: BundleIndex = { models: [], sheets: [] };

  // 2. Models
  const tModels = nowMs();
  const models: ModelOutcome[] = [];
  const versionByModelId = new Map<string, string>();
  for (let i = 0; i < manifest.models.length; i += 1) {
    throwIfAborted(signal);
    const m = manifest.models[i]!;
    onProgress?.({
      phase: "model",
      message:
        manifest.models.length > 1
          ? `Importing model ${i + 1} of ${manifest.models.length}…`
          : "Importing model…",
      current: i,
      total: manifest.models.length,
    });
    try {
      // The same model as in an earlier import (matched by model id, else by position when the
      // bundle has the same number of models) is a new VERSION of that IFC file, whatever the
      // authoring tool called the file this time.
      const prev =
        index.models.find((x) => x.id === m.id) ??
        (index.models.length === manifest.models.length ? index.models[i] : undefined);
      const ifcName =
        prev && (await findIfcFileByName(targetBuildingId, prev.ifcName)) ? prev.ifcName : basename(m.file);
      const existingFile = await findIfcFileByName(targetBuildingId, ifcName);
      const prevLatest = existingFile ? await getLatestVersion(existingFile.id) : undefined;
      const bytes = await bundle.readBytes(m.file);
      const file = new File([bytes as BlobPart], ifcName, {
        type: "application/octet-stream",
      });
      const res = await deps.ingestIfc({
        file,
        target: { kind: "byName", buildingId: targetBuildingId },
        dedupe: true,
        signal,
        onProgress: (p) =>
          onProgress?.({
            phase: "model",
            message: `Importing model… ${Math.round(p.fraction * 100)}%`,
            current: i,
            total: manifest.models.length,
          }),
      });
      const storeys = await listStoreysByVersion(res.versionId);
      versionByModelId.set(m.id, res.versionId);
      newIndex.models.push({ id: m.id, ifcName });
      models.push({
        id: m.id,
        file: m.file,
        status: "imported",
        change: !existingFile ? "new" : res.versionId === prevLatest?.id ? "unchanged" : "newVersion",
        versionId: res.versionId,
        storeyNames: storeys.map((s) => s.name),
      });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      models.push({
        id: m.id,
        file: m.file,
        status: "failed",
        storeyNames: [],
        reason: errMessage(e),
      });
      warnings.push(`Model ${m.file} failed: ${errMessage(e)}`);
    }
  }

  const modelsMs = nowMs() - tModels;
  const tBase = nowMs();
  // 3. Base shift (needs at least one converted model in the building).
  // If EVERY bundle model failed, a pre-existing model would supply the base
  // while no storey of this bundle exists: skip calibration explicitly.
  let base: BaseShift | null = null;
  const noBundleModel = manifest.models.length > 0 && versionByModelId.size === 0;
  if (noBundleModel) {
    warnings.push("No model of this bundle could be imported: sheets are imported without calibration.");
  } else try {
    const files = await listIfcFiles(targetBuildingId);
    const withVersion = new Map<string, string>();
    for (const f of files) {
      const v = await getLatestVersion(f.id);
      if (v) withVersion.set(f.id, v.id);
    }
    const baseFile = pickBaseIfcFile(files, (f) => withVersion.has(f.id));
    if (baseFile) base = await deps.readShift(withVersion.get(baseFile.id)!);
  } catch (e) {
    warnings.push(`Could not read the base model coordinates: ${errMessage(e)}`);
  }
  if (base) {
    // Remember b on the building and flag a later change of the base model:
    // calibrations made against the old b would then be offset.
    const row = await db.buildings.get(targetBuildingId);
    const prev = row?.metadata?.[BASE_SHIFT_KEY];
    if (isShift(prev) && prev.some((v, k) => Math.abs(v - base![k]!) > 1e-6)) {
      warnings.push(
        `The base model coordinates changed since the last import (was [${prev.join(", ")}], now [${base.join(", ")}]). Calibrations made earlier in this building may be offset.`,
      );
    }
    if (!isShift(prev) || prev.some((v, k) => v !== base![k])) {
      await updateBuilding(targetBuildingId, { metadata: { ...(row?.metadata ?? {}), [BASE_SHIFT_KEY]: [...base] } });
    }
  }
  if (!base && !noBundleModel) {
    warnings.push("No base model available: sheets are imported without calibration.");
  }

  const baseMs = nowMs() - tBase;
  const tSheets = nowMs();
  let pdfsMs = 0;
  // 4 + 5. Sheets and calibrations
  const sheets: SheetOutcome[] = [];
  let calibrationsCreated = 0;
  let calibrationsUpdated = 0;
  let lastPdfVersionId: string | null = null;
  const storeysCache = new Map<string, StoreyRecord[]>();
  const storeysOf = async (versionId: string) => {
    let s = storeysCache.get(versionId);
    if (!s) {
      s = await listStoreysByVersion(versionId);
      storeysCache.set(versionId, s);
    }
    return s;
  };

  const fixedNames: Array<string | null> = [];
  for (const s of manifest.sheets) {
    const prev = index.sheets.find((x) => x.id === s.id) ?? index.sheets.find((x) => x.number === s.number);
    fixedNames.push(prev && (await findPdfFileByName(targetBuildingId, prev.pdfName)) ? prev.pdfName : null);
  }
  // two sheets must never share one kept name
  const seenFixed = new Set<string>();
  fixedNames.forEach((n, k) => {
    if (n && seenFixed.has(n)) fixedNames[k] = null;
    else if (n) seenFixed.add(n);
  });
  const pdfNames = assignSheetPdfNames(manifest.sheets, fixedNames);
  for (let i = 0; i < manifest.sheets.length; i += 1) {
    throwIfAborted(signal);
    const sheet = manifest.sheets[i]!;
    const pdfName = pdfNames[i]!;
    if (pdfName.renamedFrom) {
      warnings.push(
        `Sheet ${sheet.number}: another sheet already uses the PDF name "${pdfName.renamedFrom}"; imported as "${pdfName.name}".`,
      );
    }
    const outcome: SheetOutcome = {
      number: sheet.number,
      name: sheet.name,
      status: "failed",
    };
    sheets.push(outcome);
    onProgress?.({
      phase: "sheet",
      message: `Sheet ${i + 1} of ${manifest.sheets.length} — ${sheet.number}`,
      current: i,
      total: manifest.sheets.length,
    });

    if (!bundle.has(sheet.file)) {
      outcome.status = "skipped";
      outcome.reason = `file ${sheet.file} is missing from the bundle`;
      continue;
    }

    let pdf: LoadPdfResult;
    const tPdf = nowMs();
    try {
      const bytes = await bundle.readBytes(sheet.file);
      const name = pdfName.name;
      const hash = await fullContentHash(bytes);
      const existing = await findPdfFileByName(targetBuildingId, name);
      const latest = existing ? await getLatestPdfVersion(existing.id) : undefined;
      if (existing && latest && latest.contentHash === hash) {
        pdf = {
          pdfFileId: existing.id,
          versionId: latest.id,
          versionNumber: latest.versionNumber,
          isNewFile: false,
        };
        outcome.status = "unchanged";
      } else {
        const file = new File([bytes as BlobPart], name, { type: "application/pdf" });
        pdf = await deps.importPdf(file, targetBuildingId, { contentHash: hash });
        outcome.status = pdf.isNewFile ? "imported" : "newVersion";
      }
      newIndex.sheets.push({ id: sheet.id, number: sheet.number, pdfName: name });
      outcome.pdfFileId = pdf.pdfFileId;
      outcome.versionId = pdf.versionId;
      lastPdfVersionId = pdf.versionId;
    } catch (e) {
      pdfsMs += nowMs() - tPdf;
      outcome.status = "failed";
      outcome.reason = errMessage(e);
      continue;
    }
    pdfsMs += nowMs() - tPdf;

    // Calibrations for this sheet.
    const plans = sheet.viewports.filter(
      (v) => v.primary && v.pdfToModel && v.storeyName,
    );
    if (plans.length === 0) continue;
    if (!base) continue;
    const pdfVersion = await getLatestPdfVersion(pdf.pdfFileId);
    if ((pdfVersion?.pageCount ?? 1) > 1) {
      warnings.push(`Sheet ${sheet.number}: PDF has several pages, not calibrated.`);
      continue;
    }
    for (const vp of plans) {
      const storeyName = vp.storeyName!;
      // Only an UNSET modelId may fall back to the first imported model; a set
      // modelId whose model failed must not be matched against another model.
      const modelVersionId = vp.modelId
        ? versionByModelId.get(vp.modelId)
        : [...versionByModelId.values()][0];
      if (vp.modelId && !modelVersionId) {
        warnings.push(
          `Sheet ${sheet.number}: model "${vp.modelId}" was not imported, so "${storeyName}" is not calibrated.`,
        );
        continue;
      }
      const storeys = modelVersionId ? await storeysOf(modelVersionId) : [];
      const storey = storeys.find((s) => s.name === storeyName);
      if (!storey) {
        warnings.push(
          `Sheet ${sheet.number}: storey "${storeyName}" not found in the imported model, not calibrated.`,
        );
        continue;
      }
      try {
        const cps = controlPointsFor(vp);
        const cal = buildCalibration(cps, base, vp.pdfToModel);
        for (const w of cal.warnings) warnings.push(`Sheet ${sheet.number}: ${w}`);
        const result = await db.transaction("rw", db.calibrations, async () => {
          const existing = await getCalibrationForPdfAndStorey(
            pdf.pdfFileId,
            storeyName,
          );
          if (existing) {
            await updateCalibration(existing.id, {
              pointPairs: cal.pointPairs,
              transformParams: cal.transformParams,
              confidence: 1,
            });
            return "updated" as const;
          }
          await createCalibration({
            projectId,
            pdfFileId: pdf.pdfFileId,
            storeyName,
            pointPairs: cal.pointPairs,
            transformParams: cal.transformParams,
            confidence: 1,
          });
          return "created" as const;
        });
        if (result === "created") calibrationsCreated += 1;
        else calibrationsUpdated += 1;
        // Make the level show up as an extracted level too.
        await setExtracted(targetBuildingId, storey.id, true);
      } catch (e) {
        warnings.push(
          `Sheet ${sheet.number}: calibration failed (${
            e instanceof CalibrationInputError ? e.message : errMessage(e)
          }).`,
        );
      }
    }
  }

  const sheetsMs = nowMs() - tSheets;
  {
    // Remember what each model / sheet became, so the next import versions them.
    const row = await db.buildings.get(targetBuildingId);
    const keepModels = index.models.filter((x) => !newIndex.models.some((n) => n.id === x.id));
    const keepSheets = index.sheets.filter((x) => !newIndex.sheets.some((n) => n.id === x.id));
    await updateBuilding(targetBuildingId, {
      metadata: {
        ...(row?.metadata ?? {}),
        [BUNDLE_INDEX_KEY]: { models: [...keepModels, ...newIndex.models], sheets: [...keepSheets, ...newIndex.sheets] },
      },
    });
  }
  onProgress?.({ phase: "done", message: "Import finished" });
  return {
    timings: { modelsMs, baseMs, pdfsMs, calibrationsMs: Math.max(0, sheetsMs - pdfsMs) },
    buildingId: targetBuildingId,
    buildingName,
    createdBuilding,
    models,
    sheets,
    calibrationsCreated,
    calibrationsUpdated,
    warnings,
    lastPdfVersionId,
  };
}

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** One-line-per-fact summary for the UI. */
export function summarizeReport(r: ImportReport): string[] {
  const count = (s: SheetStatus) => r.sheets.filter((x) => x.status === s).length;
  const mCount = (c: ItemChange) => r.models.filter((m) => m.status === "imported" && m.change === c).length;
  const lines = [
    `Models: ${mCount("new")} new, ${mCount("newVersion")} new version${mCount("newVersion") === 1 ? "" : "s"}, ${mCount("unchanged")} unchanged${r.models.some((m) => m.status === "failed") ? `, ${r.models.filter((m) => m.status === "failed").length} failed` : ""}`,
    `Sheets: ${count("imported")} new, ${count("newVersion")} new version${count("newVersion") === 1 ? "" : "s"}, ${count("unchanged")} unchanged, ${count("skipped")} skipped, ${count("failed")} failed`,
    `Calibrations: ${r.calibrationsCreated} created, ${r.calibrationsUpdated} updated`,
    `Time: model ${secs(r.timings.modelsMs)}, PDFs ${secs(r.timings.pdfsMs)}, calibration ${secs(r.timings.calibrationsMs + r.timings.baseMs)}`,
  ];
  for (const s of r.sheets) {
    if (s.status === "failed" || s.status === "skipped") {
      lines.push(`${s.status === "failed" ? "Failed" : "Skipped"} ${s.number}: ${s.reason ?? ""}`);
    }
  }
  for (const m of r.models) {
    if (m.status === "failed") lines.push(`Failed model ${m.file}: ${m.reason ?? ""}`);
  }
  return lines;
}
