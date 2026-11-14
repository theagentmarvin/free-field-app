// src/hooks/useIfcPipeline.ts
//
// React hook wrapping the IFC upload pipeline. The pipeline itself
// lives in ../pipeline/ingestIfc.ts (framework-agnostic, tested
// directly); this hook only adds React state (isLoading / progress /
// error), cancellation, and the viewer handle.
//
//   loadIfc(file, buildingId)       -> ingestIfc byName, dedupe on
//   replaceIfcVersion(fileId, file) -> ingestIfc byId,   dedupe off
//
// Both paths: per-file serialised, one web-ifc parse in the import
// worker (full-file hash computed there), every record written in ONE
// Dexie transaction with "latest" flipped last (see
// ../db/appendIfcVersion.ts). The previous version's storeys and the
// file's property catalog are replaced on BOTH paths.
//
// `deleteIfc(ifcFileId)` disposes the model from the viewer once, then
// deletes the file and everything under it in one transaction
// (`deleteIfcFile`).
//
// The hook also exposes a `registerFragments(fragments)` call so the
// <IfcViewer> component can plug its FragmentsModels instance into the
// pipeline after mount. The viewer owns world/fragments lifecycle; the
// pipeline owns DB mutations; they communicate through this ref-style
// API. We deliberately do NOT load the new .frag here: the IfcViewer's
// live query on ifcFiles / ifcVersions picks up the new
// currentVersionId and loads it with the proper scene wiring.

import { useCallback, useEffect, useRef, useState } from "react";

import { deleteIfcFile } from "../db/tables/ifcFiles";
import { listStoreys } from "../db/tables/storeys";
import { toStorageError } from "../db/errors";
import type { IfcImportProgress } from "../ifc/ifcImportOptions";
import type { ParsedIfc } from "../ifc/ifcMetadata";
import { ingestIfc, type LoadIfcResult } from "../pipeline/ingestIfc";

/** Minimal slice of OBC.FragmentsManager we depend on.
 * FragmentsManager is the high-level OBC wrapper around FragmentsModels;
 * the underlying models API is at `.core` (load, disposeModel, etc.). */
export interface FragmentsHandle {
  core: {
    load(
      buffer: ArrayBuffer,
      options: { modelId: string; raw?: boolean },
    ): Promise<unknown>;
    disposeModel(modelId: string): Promise<void>;
  };
  dispose(): void;
}

export type { LoadIfcResult } from "../pipeline/ingestIfc";

export interface UseIfcPipeline {
  loadIfc: (file: File, buildingId: string) => Promise<LoadIfcResult>;
  /**
   * Create a new IfcVersionRecord for an existing IfcFileRecord, dispose
   * the previous model from the live viewer, and let the IfcViewer's
   * reactive live-query pick up the new blob and load it.
   *
   * Same shape as a successful loadIfc() result (isNewFile=false,
   * versionNumber bumps by 1). The IfcFileRecord's name is preserved
   * (replace keeps the version chain under the same key).
   */
  replaceIfcVersion: (
    ifcFileId: string,
    file: File,
  ) => Promise<LoadIfcResult>;
  deleteIfc: (ifcFileId: string) => Promise<void>;
  /**
   * Abort the import(s) in flight: the worker is terminated and the
   * call rejects with IfcImportAbortedError (reason "aborted").
   */
  cancelImport: () => void;
  registerFragments: (fragments: FragmentsHandle | null) => void;
  isLoading: boolean;
  /**
   * Progress of the IFC conversion in flight (loadIfc /
   * replaceIfcVersion), null when idle. Throttled to whole percents.
   */
  progress: IfcImportProgress | null;
  /** Last failure; a StorageQuotaExceededError when storage is full. */
  error: Error | null;
}

// ---------- IFC parsing ----------
//
// The metadata walk and the IFC -> .frag conversion live in ../ifc/
// and run inside the IFC import Web Worker. `parseIfc` keeps its
// public home here, but as a lazy wrapper: a static re-export would
// pull web-ifc into every bundle that imports @ff/data/hooks.

export type { ParsedIfc, ParsedStorey, ParsedBuilding } from "../ifc/ifcMetadata";
export type { IfcImportProgress } from "../ifc/ifcImportOptions";
export { PIPELINE_IFC_IMPORT_OPTIONS } from "../ifc/ifcImportOptions";
export {
  IfcImportAbortedError,
  type IfcImportAbortReason,
} from "../ifc/ifcImportClient";
export { StorageQuotaExceededError } from "../db/errors";

/** Standalone metadata parse (own web-ifc instance), loaded on demand. */
export async function parseIfc(bytes: Uint8Array): Promise<ParsedIfc> {
  const mod = await import("../ifc/ifcMetadata");
  return mod.parseIfc(bytes);
}

// ---------- Pipeline ----------

function asError(e: unknown): Error {
  const mapped = toStorageError(e);
  return mapped instanceof Error ? mapped : new Error(String(mapped));
}

export function useIfcPipeline(): UseIfcPipeline {
  const fragmentsRef = useRef<FragmentsHandle | null>(null);
  const controllersRef = useRef(new Set<AbortController>());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [progress, setProgress] = useState<IfcImportProgress | null>(null);

  const registerFragments = useCallback(
    (fragments: FragmentsHandle | null) => {
      fragmentsRef.current = fragments;
    },
    [],
  );

  const cancelImport = useCallback(() => {
    for (const c of controllersRef.current) c.abort();
  }, []);

  const runIngest = useCallback(
    async (
      run: (signal: AbortSignal) => Promise<LoadIfcResult>,
    ): Promise<LoadIfcResult> => {
      const ctl = new AbortController();
      controllersRef.current.add(ctl);
      setIsLoading(true);
      setError(null);
      try {
        return await run(ctl.signal);
      } catch (e) {
        const err = asError(e);
        setError(err);
        throw err;
      } finally {
        controllersRef.current.delete(ctl);
        setIsLoading(false);
        setProgress(null);
      }
    },
    [],
  );

  const loadIfc = useCallback(
    (file: File, buildingId: string): Promise<LoadIfcResult> =>
      runIngest((signal) =>
        ingestIfc({
          file,
          target: { kind: "byName", buildingId },
          dedupe: true,
          onProgress: setProgress,
          signal,
        }),
      ),
    [runIngest],
  );

  const replaceIfcVersion = useCallback(
    (ifcFileId: string, file: File): Promise<LoadIfcResult> =>
      runIngest(async (signal) => {
        const res = await ingestIfc({
          file,
          target: { kind: "byId", ifcFileId },
          dedupe: false,
          onProgress: setProgress,
          signal,
        });
        // Dispose the old model; the IfcViewer's live query loads the
        // new currentVersionId (the pipeline has no world / scene).
        const fragments = fragmentsRef.current;
        if (fragments) {
          try {
            await fragments.core.disposeModel(ifcFileId);
          } catch (viewerErr) {
            // eslint-disable-next-line no-console
            console.warn("[useIfcPipeline] disposeModel on replace:", viewerErr);
          }
        }
        return res;
      }),
    [runIngest],
  );

  const deleteIfc = useCallback(
    async (ifcFileId: string): Promise<void> => {
      setIsLoading(true);
      setError(null);
      try {
        // The viewer holds ONE model per file (modelId = ifcFileId):
        // dispose it once, whatever the number of versions.
        const fragments = fragmentsRef.current;
        if (fragments) {
          try {
            await fragments.core.disposeModel(ifcFileId);
          } catch (viewerErr) {
            // eslint-disable-next-line no-console
            console.warn(
              "[useIfcPipeline] disposeModel failed (continuing):",
              viewerErr,
            );
          }
        }
        // File + versions + blobs + storeys + extracted storeys +
        // catalog, in one transaction.
        await deleteIfcFile(ifcFileId);
      } catch (e) {
        const err = asError(e);
        setError(err);
        throw err;
      } finally {
        setIsLoading(false);
        setProgress(null);
      }
    },
    [],
  );

  // NB: no abort on unmount — an import keeps running (and lands in
  // the DB) when e.g. the sidebar that started it closes. Use
  // cancelImport() to stop one explicitly.

  // Auto-clear transient errors after 5s so they don't pin the UI.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(t);
  }, [error]);

  return {
    loadIfc,
    replaceIfcVersion,
    deleteIfc,
    cancelImport,
    registerFragments,
    isLoading,
    progress,
    error,
  };
}

// ---------- Helpers ----------

/**
 * Return the unioned list of storey names + elevations for a
 * building by walking the storeys table.  On conflict (same name
 * from multiple IFCs) the lowest elevation wins.
 *
 * Used by IfcViewer to feed the LevelPlanController's metadata
 * map after OBC.Views.createFromIfcStoreys is removed (Task 16).
 */
export async function getStoreysForBuilding(
  buildingId: string,
): Promise<{ name: string; elevation: number; height: number | null }[]> {
  const rows = await listStoreys(buildingId);
  if (rows.length === 0) return [];

  // "Lowest elevation wins" merge semantics — correct for storeys that
  // appear in multiple IFCs (e.g. re-imported). Carry `height` along
  // with the elevation.
  const merged = new Map<string, { elevation: number; height: number | null }>();
  for (const r of rows) {
    const prev = merged.get(r.name);
    if (prev === undefined || r.elevation < prev.elevation) {
      merged.set(r.name, { elevation: r.elevation, height: r.height });
    }
  }

  return Array.from(merged.entries())
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => a.elevation - b.elevation);
}
