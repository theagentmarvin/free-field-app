// src/core/db/tables/projects.ts
import { db } from "../database";
import { uuid } from "../uuid";
import type { ProjectRecord } from "@ff/types";

export type CreateProjectInput = Omit<
  ProjectRecord,
  "id" | "createdAt" | "updatedAt"
> &
  Partial<Pick<ProjectRecord, "id" | "createdAt" | "updatedAt">>;

export async function createProject(
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const now = Date.now();
  const record: ProjectRecord = {
    id: input.id ?? uuid(),
    name: input.name,
    metadata: input.metadata ?? {},
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
  await db.projects.add(record);
  return record;
}

export async function getProject(id: string): Promise<ProjectRecord | undefined> {
  return db.projects.get(id);
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return db.projects.orderBy("createdAt").toArray();
}

export type UpdateProjectPatch = Partial<
  Omit<ProjectRecord, "id" | "createdAt">
>;

export async function updateProject(
  id: string,
  patch: UpdateProjectPatch,
): Promise<void> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteProject(id: string): Promise<void> {
  // Cascade: delete all buildings → their IFCs (handled by each table).
  const buildings = await db.buildings.where("projectId").equals(id).toArray();
  const { deleteBuilding } = await import("./buildings");
  for (const b of buildings) {
    await deleteBuilding(b.id);
  }
  await db.projects.delete(id);
}
