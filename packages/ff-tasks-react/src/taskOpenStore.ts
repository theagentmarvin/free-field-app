// packages/ff-tasks-react/src/taskOpenStore.ts
//
// Quick access from a task's location: the cross-module "open this task's
// view" request. A thumb / detail card posts an INTENT here; the shell
// bridge switches building + route, and Models / Documents consume the
// intent once their surface is ready (restore the saved camera and select
// the elements, or open the sheet at the page and zoom to the pin).
//
// A tiny external store (no zustand dependency): one pending intent, one
// user-facing notice and the pin highlighted on the plan.

import { useSyncExternalStore } from "react";

import type { TaskLocation } from "@ff/firestore";

export interface TaskOpenBase {
  /** monotonically increasing request id */
  id: number;
  taskId: string;
  /** building that owns the target (the shell switches to it first) */
  buildingId: string | null;
}

export interface TaskOpenModelsIntent extends TaskOpenBase {
  kind: "models";
  elements: { modelId: string; expressId: number }[];
  worldPoint: [number, number, number] | null;
  cameraPose: NonNullable<NonNullable<TaskLocation["bim"]>["cameraPose"]> | null;
}

export interface TaskOpenDocumentsIntent extends TaskOpenBase {
  kind: "documents";
  pdfFileId: string;
  /** the version to open (latest of the sheet unless a chosen version) */
  versionId: string;
  page: number;
  uv: [number, number] | null;
}

/**
 * LinkView dual location: one intent carrying BOTH halves of a task
 * created in LinkView (plan pin + 3D placement). Either half is null when
 * its target no longer exists (the notice says so); LinkView applies
 * whichever halves are present.
 */
export interface TaskOpenLinkviewIntent extends TaskOpenBase {
  kind: "linkview";
  documents: Pick<TaskOpenDocumentsIntent, "pdfFileId" | "versionId" | "page" | "uv"> | null;
  models: Pick<TaskOpenModelsIntent, "elements" | "worldPoint" | "cameraPose"> | null;
}

export type TaskOpenIntent = TaskOpenModelsIntent | TaskOpenDocumentsIntent | TaskOpenLinkviewIntent;
export type TaskOpenIntentInput =
  | Omit<TaskOpenModelsIntent, "id">
  | Omit<TaskOpenDocumentsIntent, "id">
  | Omit<TaskOpenLinkviewIntent, "id">;

export interface TaskOpenState {
  intent: TaskOpenIntent | null;
  notice: string | null;
  /** task whose plan pin is highlighted after a quick-access open */
  highlightTaskId: string | null;
}

let state: TaskOpenState = { intent: null, notice: null, highlightTaskId: null };
let seq = 0;
const listeners = new Set<() => void>();

function set(next: Partial<TaskOpenState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

export function getTaskOpenState(): TaskOpenState {
  return state;
}

export function subscribeTaskOpen(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Post a new open request (replaces any pending one). */
export function requestTaskOpen(input: TaskOpenIntentInput, notice: string | null = null): TaskOpenIntent {
  seq += 1;
  const intent = { ...input, id: seq } as TaskOpenIntent;
  set({ intent, notice, highlightTaskId: null });
  return intent;
}

/** Take the pending intent when it is of `kind` (clears it). */
export function consumeTaskOpen<K extends TaskOpenIntent["kind"]>(
  kind: K,
): Extract<TaskOpenIntent, { kind: K }> | null {
  const cur = state.intent;
  if (!cur || cur.kind !== kind) return null;
  set({ intent: null });
  return cur as Extract<TaskOpenIntent, { kind: K }>;
}

export function setTaskOpenNotice(notice: string | null): void {
  set({ notice });
}

export function setTaskHighlight(taskId: string | null): void {
  set({ highlightTaskId: taskId });
}

/** Test helper. */
export function resetTaskOpenStore(): void {
  state = { intent: null, notice: null, highlightTaskId: null };
  for (const l of listeners) l();
}

export function useTaskOpenState(): TaskOpenState {
  return useSyncExternalStore(subscribeTaskOpen, getTaskOpenState, getTaskOpenState);
}
