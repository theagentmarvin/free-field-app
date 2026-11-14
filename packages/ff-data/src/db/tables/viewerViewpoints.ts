// src/core/db/tables/viewerViewpoints.ts
//
// CRUD for the v10 `viewerViewpoints` table. One row per saved 3D
// viewpoint, scoped to a project. Mirrors the shape of the other
// CRUD modules in this directory: pure functions, no React, no
// live-query logic (the toolbar reads the list imperatively — the
// saved-views list is opened on demand and re-reads each time).
//
// Cap: `MAX_VIEWPOINTS_PER_PROJECT` (12). The create path evicts
// the oldest rows for the same project before inserting, so the
// table never grows unbounded per project. This is view-state
// persistence both in demo AND cloud mode for now — cloud sync is a
// future schema wave (see the Wave-13 spec, Deliverable B).

import { db } from "../database";
import { uuid } from "../uuid";
import type { ViewerViewpointRecord } from "@ff/types";

/** Hard cap on saved views per project (documented in the Wave-13 spec). */
export const MAX_VIEWPOINTS_PER_PROJECT = 12;

export type CreateViewerViewpointInput = Omit<
  ViewerViewpointRecord,
  "id" | "createdAt"
> &
  Partial<Pick<ViewerViewpointRecord, "id" | "createdAt">>;

/**
 * Insert a new viewpoint, evicting the oldest rows for the same
 * project first so the count never exceeds `MAX_VIEWPOINTS_PER_PROJECT`.
 * The eviction is oldest-first (`createdAt` ascending). Returns the
 * inserted record (post-eviction).
 */
export async function createViewerViewpoint(
  input: CreateViewerViewpointInput,
): Promise<ViewerViewpointRecord> {
  const now = Date.now();

  // Evict oldest → newest. `sortBy("createdAt")` uses the secondary
  // `createdAt` index declared in the schema.
  const existing = await db.viewerViewpoints
    .where("projectId")
    .equals(input.projectId)
    .sortBy("createdAt");
  while (existing.length >= MAX_VIEWPOINTS_PER_PROJECT) {
    const oldest = existing.shift();
    if (oldest) await db.viewerViewpoints.delete(oldest.id);
  }

  const record: ViewerViewpointRecord = {
    id: input.id ?? uuid(),
    projectId: input.projectId,
    name: input.name,
    createdAt: input.createdAt ?? now,
    blob: input.blob,
  };
  await db.viewerViewpoints.add(record);
  return record;
}

/** List a project's saved views, oldest first. */
export async function listViewerViewpoints(
  projectId: string,
): Promise<ViewerViewpointRecord[]> {
  return db.viewerViewpoints
    .where("projectId")
    .equals(projectId)
    .sortBy("createdAt");
}

export async function getViewerViewpoint(
  id: string,
): Promise<ViewerViewpointRecord | undefined> {
  return db.viewerViewpoints.get(id);
}

export async function deleteViewerViewpoint(id: string): Promise<void> {
  await db.viewerViewpoints.delete(id);
}

/**
 * Cascade-delete every saved view for a project. Called when a project
 * (and its views) should stop existing. No-op if the project unknown.
 */
export async function deleteViewerViewpointsForProject(
  projectId: string,
): Promise<void> {
  await db.viewerViewpoints
    .where("projectId")
    .equals(projectId)
    .delete();
}