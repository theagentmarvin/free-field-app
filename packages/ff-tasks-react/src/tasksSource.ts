import { useMemo } from "react";
import type { FirebaseApp } from "firebase/app";
import { getFirestore, type Firestore } from "firebase/firestore";
import { getDownloadURL, getStorage, ref } from "firebase/storage";

import { useAuthContext } from "@ff/auth";
import type { Task, TaskEntry } from "@ff/firestore";
import {
  getDemoTaskSource,
  watchTask as cloudWatchTask,
  watchTaskEntries as cloudWatchTaskEntries,
  watchTasks as cloudWatchTasks,
  deleteTaskDoc,
} from "@ff/tasks";

import type { PhotoUrlResolver } from "./usePhotoUrl";
import type { TaskPerson } from "./useTaskPeople";

/**
 * The single structural switch for the task data plane. Every host reads
 * its live queries through this source instead of branching on `isDemo`
 * itself: the cloud path delegates to the Firestore `watchTasks` /
 * `watchTask` / `watchTaskEntries` verbs (unchanged), and the demo path
 * delegates to the Dexie-backed `DemoTaskSource` (login-free, offline).
 *
 * `overlaySending` is true on both paths since wave 63: the cloud
 * path commits through Firestore transactions, which are NOT applied
 * to the local cache before the server acks them, so `sending` rows
 * must be overlaid as pending exactly like demo does.
 */

export interface TasksSource {
  readonly overlaySending: boolean;
  watchTasks(
    projectId: string,
    statuses: number[] | null,
    cb: (tasks: Task[]) => void,
    max?: number,
  ): () => void;
  watchTask(
    projectId: string,
    taskId: string,
    cb: (task: Task | null) => void,
  ): () => void;
  watchTaskEntries(
    projectId: string,
    taskId: string,
    cb: (entries: TaskEntry[]) => void,
  ): () => void;
  /** Admin hard delete (task + timeline). Cloud needs the rules change
   *  in docs/integration/w69-tasks-rules.md; gated by useTaskCapabilities. */
  deleteTask(projectId: string, taskId: string): Promise<void>;
}

function cloudSource(app: FirebaseApp): TasksSource {
  const db = getFirestore(app);
  return {
    // Wave 63: transactions don't write the local cache, so in-flight
    // rows must be overlaid here too (merge dedupes landed ones).
    overlaySending: true,
    watchTasks: (projectId, statuses, cb, max = 50) =>
      cloudWatchTasks(db, projectId, statuses, cb, max),
    watchTask: (projectId, taskId, cb) =>
      cloudWatchTask(db, projectId, taskId, cb),
    watchTaskEntries: (projectId, taskId, cb) =>
      cloudWatchTaskEntries(db, projectId, taskId, cb),
    deleteTask: (projectId, taskId) => deleteTaskDoc(db, projectId, taskId),
  };
}

function demoSource(): TasksSource {
  const demo = getDemoTaskSource();
  return {
    overlaySending: true,
    watchTasks: (projectId, statuses, cb, max = 50) =>
      demo.watchTasks(projectId, statuses, cb, max),
    watchTask: (projectId, taskId, cb) => demo.watchTask(projectId, taskId, cb),
    watchTaskEntries: (projectId, taskId, cb) =>
      demo.watchTaskEntries(projectId, taskId, cb),
    deleteTask: (projectId, taskId) => demo.deleteTask(projectId, taskId),
  };
}

/** The one hook: resolves the live-query source for the ambient auth mode. */
export function useTasksSource(): TasksSource {
  const { app, isDemo } = useAuthContext();
  return useMemo(() => (isDemo ? demoSource() : cloudSource(app)), [app, isDemo]);
}

/** A Firestore instance, or null in demo (callers hand it to the people
 *  feed / roster — null selects the demo roster inside `useTaskPeople`). */
export function useTasksFirestore(): Firestore | null {
  const { app, isDemo } = useAuthContext();
  return useMemo(() => {
    if (isDemo) return null;
    try {
      return getFirestore(app);
    } catch {
      return null;
    }
  }, [app, isDemo]);
}

// ── Demo people ──────────────────────────────────────────────────────────

/** The demo actor ("you", the demo admin) + assignee roster shown in the
 *  compose/detail assignee pickers when there is no Firestore backend. */
export const DEMO_PEOPLE: readonly TaskPerson[] = [
  { uid: "demo-admin", name: "Alex Rivera" },
  { uid: "ana-silva", name: "Ana Silva" },
  { uid: "mateo-rojas", name: "Mateo Rojas" },
  { uid: "sofia-vargas", name: "Sofia Vargas" },
];

// ── Photo resolver factory ───────────────────────────────────────────────

/** Storage-path → display URL: demo reads data URLs from the local store,
 *  cloud resolves through Firebase Storage (undefined when no bucket). */
export function makeTaskPhotoResolver(
  app: FirebaseApp,
  isDemo: boolean,
): PhotoUrlResolver | undefined {
  if (isDemo) {
    const demo = getDemoTaskSource();
    return (storagePath) => demo.resolvePhotoUrl(storagePath);
  }
  let storage: ReturnType<typeof getStorage>;
  try {
    storage = getStorage(app);
  } catch {
    return undefined; // no bucket configured — rows render without thumbs
  }
  return async (storagePath: string): Promise<string | null> => {
    try {
      return await getDownloadURL(ref(storage, storagePath));
    } catch {
      return null;
    }
  };
}