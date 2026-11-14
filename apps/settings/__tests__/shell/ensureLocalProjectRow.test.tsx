// apps/settings — the ONE local `projects` row bootstrap (wave 66).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => ({ demo: false }));
vi.mock("@ff/auth", () => ({ isDemoAuth: () => h.demo }));

import { db } from "@ff/data/db/database";
import {
  ensureLocalProjectRow,
  useEnsureLocalProjectRow,
} from "@shell/ensureLocalProjectRow";

import { resetDb } from "../db/helpers";

beforeEach(async () => {
  h.demo = false;
  await resetDb("EnsureProjectRow");
});

describe("ensureLocalProjectRow", () => {
  it("creates the row for the current project with its name", async () => {
    await ensureLocalProjectRow("p1", "Tower A");
    const row = await db.projects.get("p1");
    expect(row?.name).toBe("Tower A");
    expect(await db.projects.get("default-project")).toBeUndefined();
  });

  it("is idempotent and never overwrites an existing row", async () => {
    await ensureLocalProjectRow("p1", "Tower A");
    await ensureLocalProjectRow("p1", "Renamed");
    await Promise.all([ensureLocalProjectRow("p1"), ensureLocalProjectRow("p1")]);
    expect(await db.projects.count()).toBe(1);
    expect((await db.projects.get("p1"))?.name).toBe("Tower A");
  });

  it("falls back to a generic name when none is known", async () => {
    await ensureLocalProjectRow("p2");
    expect((await db.projects.get("p2"))?.name).toBe("Project");
  });

  it("writes nothing without a project id", async () => {
    await ensureLocalProjectRow(undefined, "x");
    await ensureLocalProjectRow(null, "x");
    expect(await db.projects.count()).toBe(0);
  });

  it("writes nothing in demo mode (the demo seed owns the row)", async () => {
    h.demo = true;
    await ensureLocalProjectRow("default-project", "Demo");
    expect(await db.projects.count()).toBe(0);
  });
});

describe("useEnsureLocalProjectRow", () => {
  it("creates the row once a project id appears, and nothing before", async () => {
    const { rerender } = renderHook(({ id }: { id: string | null }) => useEnsureLocalProjectRow(id, "N"), {
      initialProps: { id: null as string | null },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(await db.projects.count()).toBe(0);
    rerender({ id: "p9" });
    await waitFor(async () => expect(await db.projects.get("p9")).toBeTruthy());
  });
});
