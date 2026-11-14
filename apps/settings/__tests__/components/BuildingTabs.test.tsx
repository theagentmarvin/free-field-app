// __tests__/components/BuildingTabs.test.tsx
//
// Unit tests for <BuildingTabs>: tab rendering, kebab menu, inline
// rename, add dialog, delete confirm. We mount the component with a
// fresh Dexie instance (shared fake-indexeddb via __tests__/setup.ts)
// and exercise the live-query + action paths through the UI.

import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";
import BuildingTabs from "@components/BuildingTabs";

import { resetDb } from "../db/helpers";

async function makeProjectAndBuildings(names: string[]) {
  const p = await createProject({ name: "Test", metadata: {} });
  const out = [];
  for (const n of names) {
    out.push(
      await createBuilding({ projectId: p.id, name: n, metadata: {} }),
    );
  }
  return { project: p, buildings: out };
}

describe("<BuildingTabs>", () => {
  beforeEach(async () => {
    await resetDb("BuildingTabs");
  });

  it("renders one tab per existing building", async () => {
    const { project, buildings } = await makeProjectAndBuildings([
      "Tower A",
      "Tower B",
    ]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={buildings[0].id}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Tower A")).toBeInTheDocument();
      expect(screen.getByText("Tower B")).toBeInTheDocument();
    });
  });

  it("auto-selects the first building when none is active", async () => {
    const { project } = await makeProjectAndBuildings(["Tower A", "Tower B"]);
    let active: string | null = "preselected";
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={active}
        onActiveBuildingChange={(id) => {
          active = id;
        }}
      />,
    );
    await waitFor(() => {
      // The active id should be flipped to one of the buildings.
      expect(active).not.toBe("preselected");
      expect(active).toBeTruthy();
    });
  });

  it("clicking a tab fires onActiveBuildingChange", async () => {
    const { project, buildings } = await makeProjectAndBuildings([
      "A",
      "B",
    ]);
    let active: string | null = buildings[0].id;
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={active}
        onActiveBuildingChange={(id) => {
          active = id;
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("B")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByText("B"));
    });
    expect(active).toBe(buildings[1].id);
  });

  it("clicking + opens the create dialog, which adds a building on submit", async () => {
    const { project } = await makeProjectAndBuildings(["A"]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={null}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("building-tabs-add")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("building-tabs-add"));
    });
    const input = await screen.findByLabelText("Building name");
    await act(async () => {
      fireEvent.change(input, { target: { value: "New Tower" } });
      fireEvent.submit(input.closest("form")!);
    });
    await waitFor(async () => {
      const rows = await db.buildings
        .where("projectId")
        .equals(project.id)
        .toArray();
      expect(rows.map((r) => r.name).sort()).toEqual(["A", "New Tower"]);
    });
  });

  it("kebab menu opens Rename + Delete options", async () => {
    const { project, buildings } = await makeProjectAndBuildings(["Solo"]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={buildings[0].id}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/Open menu for Solo/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Open menu for Solo/));
    });
    await waitFor(() => {
      expect(screen.getByText("Rename")).toBeInTheDocument();
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });

  it("Rename switches to inline edit and persists on Enter", async () => {
    const { project, buildings } = await makeProjectAndBuildings(["Old Name"]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={buildings[0].id}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/Open menu for Old Name/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Open menu for Old Name/));
    });
    const renameBtn = await screen.findByText("Rename");
    await act(async () => {
      fireEvent.click(renameBtn);
    });
    const input = await screen.findByLabelText("Rename building");
    await act(async () => {
      fireEvent.change(input, { target: { value: "New Name" } });
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await waitFor(async () => {
      const got = await db.buildings.get(buildings[0].id);
      expect(got?.name).toBe("New Name");
    });
  });

  it("Delete opens a confirm dialog; cancel keeps the building", async () => {
    const { project, buildings } = await makeProjectAndBuildings(["Stays"]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={buildings[0].id}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/Open menu for Stays/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Open menu for Stays/));
    });
    const deleteBtn = await screen.findByText("Delete");
    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    // Confirm dialog appears.
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    // Click Cancel.
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    await waitFor(async () => {
      const got = await db.buildings.get(buildings[0].id);
      expect(got).toBeDefined();
    });
  });

  it("Delete confirm removes the building", async () => {
    const { project, buildings } = await makeProjectAndBuildings(["Doomed"]);
    render(
      <BuildingTabs
        projectId={project.id}
        activeBuildingId={buildings[0].id}
        onActiveBuildingChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/Open menu for Doomed/)).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Open menu for Doomed/));
    });
    const deleteBtn = await screen.findByText("Delete");
    await act(async () => {
      fireEvent.click(deleteBtn);
    });
    // Click the dialog's Delete (the second one — the confirm button).
    const dialog = await screen.findByRole("dialog");
    const confirmBtn = dialog.querySelector(
      "button[type='button']:last-child",
    ) as HTMLButtonElement;
    expect(confirmBtn.textContent).toBe("Delete");
    await act(async () => {
      fireEvent.click(confirmBtn);
    });
    await waitFor(async () => {
      const got = await db.buildings.get(buildings[0].id);
      expect(got).toBeUndefined();
    });
  });
});
