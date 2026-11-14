// __tests__/db/projects.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
} from "@ff/data/db/tables/projects";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { resetDb } from "./helpers";

describe("projects table", () => {
  beforeEach(async () => {
    await resetDb("projects");
  });

  it("creates a project with sensible defaults", async () => {
    const p = await createProject({ name: "Sample BIM", metadata: {} });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe("Sample BIM");
    expect(p.createdAt).toBeGreaterThan(0);
    expect(p.updatedAt).toBe(p.createdAt);
  });

  it("reads a project by id", async () => {
    const p = await createProject({ name: "A", metadata: {} });
    const got = await getProject(p.id);
    expect(got?.id).toBe(p.id);
  });

  it("returns undefined for unknown id", async () => {
    expect(await getProject("nope")).toBeUndefined();
  });

  it("lists projects ordered by createdAt", async () => {
    const a = await createProject({ name: "A", metadata: {} });
    await new Promise((r) => setTimeout(r, 2));
    const b = await createProject({ name: "B", metadata: {} });
    const all = await listProjects();
    expect(all.map((p) => p.id)).toEqual([a.id, b.id]);
  });

  it("updates a project and bumps updatedAt", async () => {
    const p = await createProject({ name: "Old", metadata: {} });
    const originalUpdatedAt = p.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await updateProject(p.id, { name: "New" });
    const got = await getProject(p.id);
    expect(got?.name).toBe("New");
    expect(got?.updatedAt).toBeGreaterThan(originalUpdatedAt);
  });

  it("deletes a project", async () => {
    const p = await createProject({ name: "Doomed", metadata: {} });
    await deleteProject(p.id);
    expect(await getProject(p.id)).toBeUndefined();
  });

  it("cascades delete to its buildings", async () => {
    const p = await createProject({ name: "P", metadata: {} });
    const b = await createBuilding({ projectId: p.id, name: "Tower A", metadata: {} });
    await deleteProject(p.id);
    expect(await getProject(p.id)).toBeUndefined();
    // Building should be gone too (cascade).
    const { getBuilding } = await import("@ff/data/db/tables/buildings");
    expect(await getBuilding(b.id)).toBeUndefined();
  });
});
