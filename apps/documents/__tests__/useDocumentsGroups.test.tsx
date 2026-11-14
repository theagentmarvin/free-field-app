// Wave 63 — the grouped PDF list must follow a building switch at once
// (the memo used to miss `buildingId` in its deps, so a switch kept the
// old building's rows until some unrelated Dexie write).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";

import { useDocumentsGroups } from "../src/hooks/useDocumentsGroups";

async function seed(buildingId: string, fileId: string, projectId = "default-project"): Promise<void> {
  await db.buildings.put({
    id: buildingId,
    projectId,
    name: buildingId,
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
  await db.pdfFiles.put({ id: fileId, buildingId, name: `${fileId}.pdf`, createdAt: 1, updatedAt: 1 });
  await db.pdfVersions.put({
    id: `${fileId}-v1`,
    pdfFileId: fileId,
    versionNumber: 1,
    name: `${fileId}.pdf`,
    size: 1,
    contentHash: `h-${fileId}`,
    pageCount: 1,
    width: 595,
    height: 842,
    storedAt: 1,
    blobKey: `blob-${fileId}`,
    isLatest: true,
  });
}

describe("useDocumentsGroups — building switch (wave 63)", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.transaction("rw", db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    await seed("b1", "f1");
    await seed("b2", "f2");
  });

  it("recomputes the rows when only the building changes", async () => {
    const { result, rerender } = renderHook(({ b }) => useDocumentsGroups(b), {
      initialProps: { b: "b1" as string | null },
    });
    await waitFor(() => expect(result.current?.rows.map((r) => r.file.id)).toEqual(["f1"]));
    rerender({ b: "b2" });
    expect(result.current?.rows.map((r) => r.file.id)).toEqual(["f2"]);
  });
});

describe("useDocumentsGroups — project scoping (wave 66)", () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.transaction("rw", db.tables, async () => {
      await Promise.all(db.tables.map((t) => t.clear()));
    });
    await seed("b1", "f1");
    await seed("bx", "fx", "other-project");
  });
  afterEach(() => {
    (globalThis as { __ffNoProject?: boolean }).__ffNoProject = false;
  });

  it("lists only PDFs of buildings in the current project", async () => {
    const { result } = renderHook(() => useDocumentsGroups(null));
    await waitFor(() => expect(result.current?.rows.map((r) => r.file.id)).toEqual(["f1"]));
  });

  it("stays in the loading state (no rows) while there is no project", async () => {
    (globalThis as { __ffNoProject?: boolean }).__ffNoProject = true;
    const { result } = renderHook(() => useDocumentsGroups(null));
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeUndefined();
  });
});
