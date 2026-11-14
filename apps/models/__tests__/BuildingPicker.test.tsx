// apps/models/__tests__/BuildingPicker.test.tsx
//
// Tests for the building selection dropdown added to the Models
// module sidebar. These cover the user-visible behavior:
//   1. Renders the active building's name on the trigger.
//   2. Shows a fallback label when no building is selected.
//   3. Opens the listbox on click and lists every building in the
//      project's `buildings` Dexie table.
//   4. Selecting an option calls onBuildingChange and closes.
//   5. Outside-click closes the popover.
//   6. Renders the empty state when no buildings exist.

import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ pid: "p1" as string | undefined }));
vi.mock("@ff/auth", async (o) => ({
  ...(await o<Record<string, unknown>>()),
  useProjectId: () => auth.pid,
}));

import { db } from "@ff/data/db/database";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";

import BuildingPicker, { useBuildingOptions } from "../src/BuildingPicker";

const PROJECT_ID = "p1";

async function seedProject(): Promise<void> {
  await createProject({ id: PROJECT_ID, name: "Default", metadata: {} });
}

async function clearDb(): Promise<void> {
  await db.buildings.clear();
  await db.projects.clear();
}

afterEach(async () => {
  auth.pid = "p1";
  await clearDb();
});

describe("BuildingPicker", () => {
  it("shows the active building's name on the trigger", async () => {
    await seedProject();
    const b = await createBuilding({
      projectId: PROJECT_ID,
      name: "NBU_MedicalClinic_Arch",
      metadata: {},
    });

    render(
      <BuildingPicker
        activeBuildingId={b.id}
        onBuildingChange={() => {}}
      />,
    );

    // Active building label is rendered on the trigger.
    await waitFor(() => {
      expect(screen.getByTestId("building-picker-trigger")).toHaveTextContent(
        "NBU_MedicalClinic_Arch",
      );
    });
  });

  it("shows a fallback label when no building is selected", async () => {
    render(
      <BuildingPicker
        activeBuildingId={null}
        onBuildingChange={() => {}}
      />,
    );

    expect(screen.getByTestId("building-picker-trigger")).toHaveTextContent(
      "Select building",
    );
  });

  it("lists all project buildings when opened", async () => {
    await seedProject();
    const a = await createBuilding({
      projectId: PROJECT_ID,
      name: "Alpha",
      metadata: {},
    });
    const b = await createBuilding({
      projectId: PROJECT_ID,
      name: "Bravo",
      metadata: {},
    });
    const c = await createBuilding({
      projectId: PROJECT_ID,
      name: "Charlie",
      metadata: {},
    });

    render(
      <BuildingPicker
        activeBuildingId={a.id}
        onBuildingChange={() => {}}
      />,
    );

    // Open the dropdown.
    fireEvent.click(screen.getByTestId("building-picker-trigger"));

    // Live-query hydrates asynchronously; wait for the options.
    await waitFor(() => {
      expect(screen.getByTestId("building-picker-list")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`building-picker-option-${a.id}`),
    ).toHaveTextContent("Alpha");
    expect(
      screen.getByTestId(`building-picker-option-${b.id}`),
    ).toHaveTextContent("Bravo");
    expect(
      screen.getByTestId(`building-picker-option-${c.id}`),
    ).toHaveTextContent("Charlie");
  });

  it("calls onBuildingChange and closes when an option is picked", async () => {
    await seedProject();
    const a = await createBuilding({
      projectId: PROJECT_ID,
      name: "Alpha",
      metadata: {},
    });
    const b = await createBuilding({
      projectId: PROJECT_ID,
      name: "Bravo",
      metadata: {},
    });
    const onChange = vi.fn();

    render(
      <BuildingPicker
        activeBuildingId={a.id}
        onBuildingChange={onChange}
      />,
    );

    fireEvent.click(screen.getByTestId("building-picker-trigger"));
    await waitFor(() => {
      expect(
        screen.getByTestId(`building-picker-option-${b.id}`),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`building-picker-option-${b.id}`));

    expect(onChange).toHaveBeenCalledWith(b.id);
    // Popover is closed after selection.
    await waitFor(() => {
      expect(
        screen.queryByTestId("building-picker-list"),
      ).not.toBeInTheDocument();
    });
  });

  it("closes the popover on outside click", async () => {
    await seedProject();
    const a = await createBuilding({
      projectId: PROJECT_ID,
      name: "Alpha",
      metadata: {},
    });

    render(
      <div>
        <div data-testid="outside">outside</div>
        <BuildingPicker
          activeBuildingId={a.id}
          onBuildingChange={() => {}}
        />
      </div>,
    );

    fireEvent.click(screen.getByTestId("building-picker-trigger"));
    await waitFor(() => {
      expect(screen.getByTestId("building-picker-list")).toBeInTheDocument();
    });

    fireEvent.pointerDown(document.body);

    await waitFor(() => {
      expect(
        screen.queryByTestId("building-picker-list"),
      ).not.toBeInTheDocument();
    });
  });

  it("renders an empty-state hint when no buildings are configured", async () => {
    // No seedProject, no buildings.
    render(
      <BuildingPicker
        activeBuildingId={null}
        onBuildingChange={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("building-picker-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("building-picker-empty")).toBeInTheDocument();
    });
  });
});

describe("useBuildingOptions (wave 65: explicit project, no implicit default)", () => {
  it("returns the given project's buildings and nothing without a project", async () => {
    await seedProject();
    await createBuilding({ projectId: PROJECT_ID, name: "Tower", metadata: {} });
    await createBuilding({ projectId: "p-other", name: "Elsewhere", metadata: {} });

    const withProject = renderHook(() => useBuildingOptions(PROJECT_ID));
    await waitFor(() => expect(withProject.result.current.map((b) => b.name)).toEqual(["Tower"]));

    const other = renderHook(() => useBuildingOptions("p-other"));
    await waitFor(() => expect(other.result.current.map((b) => b.name)).toEqual(["Elsewhere"]));

    // No current project (signed out / not chosen) → no buildings, never
    // a fallback to the legacy project.
    const none = renderHook(() => useBuildingOptions(undefined));
    await new Promise((r) => setTimeout(r, 20));
    expect(none.result.current).toEqual([]);
    const nil = renderHook(() => useBuildingOptions(null));
    await new Promise((r) => setTimeout(r, 20));
    expect(nil.result.current).toEqual([]);
  });
});

describe("BuildingPicker project scoping", () => {
  it("lists only the current project's buildings and nothing without a project", async () => {
    await createProject({ id: "p2", name: "Other", metadata: {} });
    await seedProject();
    await createBuilding({ projectId: PROJECT_ID, name: "Mine", metadata: {} });
    await createBuilding({ projectId: "p2", name: "Theirs", metadata: {} });

    const { result, rerender } = renderHook(() => useBuildingOptions(auth.pid));
    await waitFor(() => expect(result.current.map((b) => b.name)).toEqual(["Mine"]));

    auth.pid = undefined;
    rerender();
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("renders no options while the project id is undefined", async () => {
    await seedProject();
    await createBuilding({ projectId: PROJECT_ID, name: "Mine", metadata: {} });
    auth.pid = undefined;
    render(<BuildingPicker activeBuildingId={null} onBuildingChange={() => {}} />);
    fireEvent.click(screen.getByTestId("building-picker-trigger"));
    expect(screen.queryByText("Mine")).toBeNull();
  });
});
