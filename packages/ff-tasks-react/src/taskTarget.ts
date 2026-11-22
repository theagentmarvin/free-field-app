// packages/ff-tasks-react/src/taskTarget.ts
//
// Where a task's location image leads: resolve a task's stored location
// into a quick-access intent (Models with the saved camera + elements, or
// Documents on the sheet / page / pin), against the CURRENT files.
//
//   - 3D (location.bim): elements of deleted models are dropped (notice);
//     nothing left -> clear message. The camera is optional: tasks created
//     before it was stored simply frame the element.
//   - plan (location.pdf): an older / deleted pinned version falls back to
//     the latest version of the same sheet, with a message; a deleted
//     sheet -> clear message.
//   - the building is the one that OWNS the target file.

import { useCallback } from "react";

import { db as localDb } from "@ff/data/db/database";
import { isLinkviewLocation } from "@ff/tasks";

import {
  requestTaskOpen,
  setTaskOpenNotice,
  type TaskOpenDocumentsIntent,
  type TaskOpenIntentInput,
  type TaskOpenLinkviewIntent,
  type TaskOpenModelsIntent,
} from "./taskOpenStore";

export interface TargetLookup {
  ifcFiles: ReadonlyMap<string, { id: string; buildingId: string; name: string }>;
  pdfFiles: ReadonlyMap<string, { id: string; buildingId: string; name: string }>;
  pdfVersions: ReadonlyArray<{ id: string; pdfFileId: string; versionNumber: number; isLatest: boolean }>;
}

/** The task slice the resolver reads (structural: cloud docs, rows, queued creates). */
export interface OpenableTask {
  id: string;
  buildingId?: string | null;
  location?: {
    storeyName?: string | null;
    text?: string;
    bim?: {
      elements?: ReadonlyArray<unknown> | null;
      worldPoint?: ReadonlyArray<number> | null;
      cameraPose?: unknown;
    } | null;
    pdf?: unknown;
    /** 'linkview' on tasks created in LinkView (both sides stored) */
    origin?: string;
  } | null;
}

export type TaskTargetResult =
  | { ok: true; intent: TaskOpenIntentInput; notice?: string }
  | { ok: false; message: string };

/** Which module a task's location opens (for the affordance label). */
export function taskOpenKind(task: OpenableTask): "models" | "documents" | "linkview" | null {
  // Created in LinkView (origin marker + both sides): LinkView, not one half.
  if (isLinkviewLocation(task.location)) return "linkview";
  const bim = task.location?.bim;
  if (bim && (bim.elements?.length || bim.worldPoint)) return "models";
  if (task.location?.pdf) return "documents";
  return null;
}

export const OPEN_LABEL = {
  models: "Open in Models",
  documents: "Open in Documents",
  linkview: "Open in LinkView",
} as const;

interface PdfLoc {
  pdfFileId: string;
  page?: number;
  uv?: [number, number];
  pdfVersionId?: string;
}

export function resolveTaskTarget(task: OpenableTask, lookup: TargetLookup): TaskTargetResult {
  const kind = taskOpenKind(task);
  if (kind === "models") return resolveModels(task, lookup);
  if (kind === "documents") return resolveDocuments(task, lookup);
  if (kind === "linkview") return resolveLinkview(task, lookup);
  return { ok: false, message: "This task has no location to open." };
}

function resolveModels(task: OpenableTask, lookup: TargetLookup): TaskTargetResult {
  const bim = task.location!.bim!;
  const all = (bim.elements ?? []) as { modelId?: string; expressId?: number }[];
  const kept = all.filter(
    (e): e is { modelId: string; expressId: number } =>
      !!e && typeof e.modelId === "string" && typeof e.expressId === "number" && lookup.ifcFiles.has(e.modelId),
  );
  if (all.length > 0 && kept.length === 0) {
    return { ok: false, message: "The model this task was created on no longer exists." };
  }
  const first = kept[0] ? lookup.ifcFiles.get(kept[0].modelId) : undefined;
  const intent: Omit<TaskOpenModelsIntent, "id"> = {
    kind: "models",
    taskId: task.id,
    buildingId: first?.buildingId ?? task.buildingId ?? null,
    elements: kept,
    worldPoint: (bim.worldPoint as [number, number, number] | null | undefined) ?? null,
    cameraPose: (bim.cameraPose as TaskOpenModelsIntent["cameraPose"]) ?? null,
  };
  const dropped = all.length - kept.length;
  return dropped > 0
    ? { ok: true, intent, notice: `${dropped} element${dropped === 1 ? "" : "s"} of this task are on models that no longer exist.` }
    : { ok: true, intent };
}

function resolveDocuments(task: OpenableTask, lookup: TargetLookup): TaskTargetResult {
  const pdf = task.location!.pdf as PdfLoc;
  const file = lookup.pdfFiles.get(pdf.pdfFileId);
  if (!file) return { ok: false, message: "The plan sheet this task was pinned on no longer exists." };
  const versions = lookup.pdfVersions.filter((v) => v.pdfFileId === file.id);
  const latest = versions.find((v) => v.isLatest) ?? [...versions].sort((a, b) => b.versionNumber - a.versionNumber)[0];
  if (!latest) return { ok: false, message: "The plan sheet this task was pinned on has no stored version." };
  const pinned = pdf.pdfVersionId ? versions.find((v) => v.id === pdf.pdfVersionId) : undefined;
  let notice: string | undefined;
  if (pdf.pdfVersionId && !pinned) {
    notice = `The version this task was pinned on no longer exists. Showing the latest (v${latest.versionNumber}) of ${file.name}.`;
  } else if (pinned && pinned.id !== latest.id) {
    notice = `Pinned on v${pinned.versionNumber}, which has been superseded. Showing the latest (v${latest.versionNumber}) of ${file.name}.`;
  }
  const intent: Omit<TaskOpenDocumentsIntent, "id"> = {
    kind: "documents",
    taskId: task.id,
    buildingId: file.buildingId,
    pdfFileId: file.id,
    versionId: latest.id,
    page: typeof pdf.page === "number" && pdf.page >= 1 ? pdf.page : 1,
    uv: Array.isArray(pdf.uv) ? ([pdf.uv[0], pdf.uv[1]] as [number, number]) : null,
  };
  return notice ? { ok: true, intent, notice } : { ok: true, intent };
}

/**
 * LinkView task: resolve each half with the SAME rules as Models and
 * Documents (dropped elements, version fallback, missing sheet), then
 * join them into one intent. A half whose target is gone becomes null
 * with its message folded into the notice; both gone -> a clear message.
 */
function resolveLinkview(task: OpenableTask, lookup: TargetLookup): TaskTargetResult {
  const docs = resolveDocuments(task, lookup);
  const models = resolveModels(task, lookup);
  if (!docs.ok && !models.ok) {
    return { ok: false, message: `${docs.message} ${models.message}` };
  }
  const notices: string[] = [];
  let documents: TaskOpenLinkviewIntent["documents"] = null;
  let mod: TaskOpenLinkviewIntent["models"] = null;
  let buildingId: string | null = null;
  if (docs.ok) {
    const d = docs.intent as Omit<TaskOpenDocumentsIntent, "id">;
    documents = { pdfFileId: d.pdfFileId, versionId: d.versionId, page: d.page, uv: d.uv };
    buildingId = d.buildingId;
    if (docs.notice) notices.push(docs.notice);
  } else {
    notices.push(docs.message);
  }
  if (models.ok) {
    const m = models.intent as Omit<TaskOpenModelsIntent, "id">;
    mod = { elements: m.elements, worldPoint: m.worldPoint, cameraPose: m.cameraPose };
    buildingId = buildingId ?? m.buildingId;
    if (models.notice) notices.push(models.notice);
  } else {
    notices.push(models.message);
  }
  const intent: Omit<TaskOpenLinkviewIntent, "id"> = {
    kind: "linkview",
    taskId: task.id,
    buildingId: buildingId ?? task.buildingId ?? null,
    documents,
    models: mod,
  };
  return notices.length > 0 ? { ok: true, intent, notice: notices.join(" ") } : { ok: true, intent };
}

/** Live lookup of the current files from the local store. */
export async function loadTargetLookup(): Promise<TargetLookup> {
  const [ifcs, pdfs, versions] = await Promise.all([
    localDb.ifcFiles.toArray(),
    localDb.pdfFiles.toArray(),
    localDb.pdfVersions.toArray(),
  ]);
  return {
    ifcFiles: new Map(ifcs.map((f) => [f.id, f] as const)),
    pdfFiles: new Map(pdfs.map((f) => [f.id, f] as const)),
    pdfVersions: versions,
  };
}

/**
 * Open a task's location view. Posts the intent for the shell bridge
 * (building switch + route) or, when it cannot be opened, a clear notice.
 */
export async function openTaskLocation(task: OpenableTask): Promise<boolean> {
  let result: TaskTargetResult;
  try {
    result = resolveTaskTarget(task, await loadTargetLookup());
  } catch {
    result = { ok: false, message: "Could not read the project files to open this location." };
  }
  if (!result.ok) {
    setTaskOpenNotice(result.message);
    return false;
  }
  requestTaskOpen(result.intent, result.notice ?? null);
  return true;
}

/** Stable opener for components: `open(task)`. */
export function useOpenTaskLocation(): (task: OpenableTask) => void {
  return useCallback((task) => {
    void openTaskLocation(task);
  }, []);
}
