// apps/settings/src/shell/ensureLocalProjectRow.ts
//
// Wave 66 — the ONE place that makes sure the local Dexie `projects`
// row exists for the current project. Other modules (Models, Linkview,
// Documents, Settings) no longer create it themselves.
//
// Idempotent: looks the row up first, so a repeat call is a no-op. Does
// nothing without a project id and nothing in demo mode (the demo seed
// writes the row). Runs from an effect, never inside a live query
// (those are read-only transactions).

import { useEffect } from "react";

import { isDemoAuth } from "@ff/auth";
import { db } from "@ff/data/db/database";
import { createProject } from "@ff/data/db/tables/projects";

export async function ensureLocalProjectRow(
  projectId: string | null | undefined,
  name?: string | null,
): Promise<void> {
  if (!projectId) return;
  if (isDemoAuth()) return;
  const existing = await db.projects.get(projectId);
  if (existing) return;
  try {
    await createProject({ id: projectId, name: name || "Project", metadata: {} });
  } catch (err) {
    // A concurrent caller may have added it between get and add.
    if (await db.projects.get(projectId)) return;
    throw err;
  }
}

export function useEnsureLocalProjectRow(
  projectId: string | null | undefined,
  name?: string | null,
): void {
  useEffect(() => {
    if (!projectId) return;
    ensureLocalProjectRow(projectId, name).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[ff] local project row bootstrap failed", err);
    });
  }, [projectId, name]);
}
