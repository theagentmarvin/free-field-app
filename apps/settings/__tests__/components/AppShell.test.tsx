// __tests__/components/AppShell.test.tsx
//
// Wave 63 — Settings uses the app-wide active building
// (useModelsToolStore.activeBuildingId) instead of its own React state.
// Header / Sidebar / ViewerPanel are stubbed so only the wiring is
// under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const auth = vi.hoisted(() => ({ projectId: "p-real" as string | undefined }));
vi.mock("@ff/auth", async (orig) => ({
  ...(await orig<typeof import("@ff/auth")>()),
  useRequiredProjectId: () => {
    if (!auth.projectId) throw new Error("NoActiveProjectError");
    return auth.projectId;
  },
}));

vi.mock("@components/Header", () => ({
  default: (props: { projectId: string; activeBuildingId: string | null; onActiveBuildingChange: (id: string) => void }) => (
    <button data-testid="header" data-project={props.projectId} onClick={() => props.onActiveBuildingChange("b-2")}>
      {props.activeBuildingId ?? "none"}
    </button>
  ),
}));
vi.mock("@components/Sidebar", () => ({
  default: (props: { buildingId: string | null }) => (
    <div data-testid="sidebar">{props.buildingId ?? "none"}</div>
  ),
}));
vi.mock("@components/ViewerPanel", () => ({
  default: (props: { projectId: string }) => <div data-testid="viewer" data-project={props.projectId} />,
}));

import { db } from "@ff/data/db/database";
import { useModelsToolStore } from "@ff/viewer-tools";
import AppShell from "@components/AppShell";

import { resetDb } from "../db/helpers";

beforeEach(async () => {
  await resetDb("AppShell");
  await db.buildings.bulkPut([
    { id: "b-1", projectId: "default-project", name: "One", createdAt: 0, updatedAt: 0 },
    { id: "b-2", projectId: "default-project", name: "Two", createdAt: 0, updatedAt: 0 },
  ] as never);
  useModelsToolStore.getState().setActiveBuildingId("b-1");
});

afterEach(() => {
  cleanup();
  useModelsToolStore.getState().setActiveBuildingId(null);
});

describe("<AppShell> project scoping", () => {
  it("passes the current project (not a default) to Header and ViewerPanel", () => {
    auth.projectId = "p-real";
    render(<AppShell />);
    expect(screen.getByTestId("header").getAttribute("data-project")).toBe("p-real");
    expect(screen.getByTestId("viewer").getAttribute("data-project")).toBe("p-real");
  });

  it("no longer creates a local projects row itself (MainShell owns it)", async () => {
    render(<AppShell />);
    await new Promise((r) => setTimeout(r, 30));
    expect(await db.projects.count()).toBe(0);
  });

  it("throws NoActiveProjectError with no project instead of falling back", () => {
    auth.projectId = undefined;
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(() => render(<AppShell />)).toThrow(/NoActiveProject/);
    } finally {
      err.mockRestore();
      auth.projectId = "p-real";
    }
  });
});

describe("<AppShell> active building", () => {
  it("reads the shared store's active building", () => {
    render(<AppShell />);
    expect(screen.getByTestId("sidebar").textContent).toBe("b-1");
  });

  it("a Settings building change writes the shared store", () => {
    render(<AppShell />);
    fireEvent.click(screen.getByTestId("header"));
    expect(useModelsToolStore.getState().activeBuildingId).toBe("b-2");
    expect(screen.getByTestId("sidebar").textContent).toBe("b-2");
  });

  it("follows a building chosen elsewhere in the app", () => {
    render(<AppShell />);
    act(() => useModelsToolStore.getState().setActiveBuildingId("b-2"));
    expect(screen.getByTestId("sidebar").textContent).toBe("b-2");
  });
});
