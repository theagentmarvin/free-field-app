// __tests__/components/LevelChecklistPopover.test.tsx
//
// Component tests for <LevelChecklistPopover>: initial state seeded
// from Dexie, per-row toggle, group-level toggle, Apply writes
// through to Dexie, Cancel discards.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import LevelChecklistPopover from "@components/LevelChecklistPopover";
import { db } from "@ff/data/db/database";
import { createBuilding } from "@ff/data/db/tables/buildings";
import { createProject } from "@ff/data/db/tables/projects";
import { createIfcFile } from "@ff/data/db/tables/ifcFiles";
import { createIfcVersion } from "@ff/data/db/tables/ifcVersions";
import { createStoreys } from "@ff/data/db/tables/storeys";
import {
  putBuildingLevelSelection,
  listBuildingLevelSelections,
} from "@ff/data/db/tables/buildingLevelSelection";
import { listExtracted } from "@ff/data/db/tables/extractedStoreys";
import type { IfcFileWithVersions } from "@ff/data/hooks";
import type { StoreyRecord } from "@ff/types";

import { resetDb } from "../db/helpers";

async function makeSeed(): Promise<{
  buildingId: string;
  ifcFileId: string;
  ifcVersionId: string;
  storeys: StoreyRecord[];
  files: IfcFileWithVersions[];
}> {
  const p = await createProject({ name: "PopoverTest", metadata: {} });
  const b = await createBuilding({ projectId: p.id, name: "B", metadata: {} });
  const f = await createIfcFile({
    buildingId: b.id,
    name: "model.ifc",
    currentVersionId: "placeholder",
  });
  const v = await createIfcVersion({
    ifcFileId: f.id,
    versionNumber: 1,
    ifcFileSize: 1024,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 2,
    isLatest: true,
  });
  await db.ifcFiles.update(f.id, { currentVersionId: v.id });
  const s = await createStoreys([
    {
      buildingId: b.id,
      ifcVersionId: v.id,
      sourceIfcFileId: f.id,
      name: "Ground",
      elevation: 0,
      expressId: 1,
      height: null,
    },
    {
      buildingId: b.id,
      ifcVersionId: v.id,
      sourceIfcFileId: f.id,
      name: "First Floor",
      elevation: 3,
      expressId: 2,
      height: null,
    },
  ]);
  const files: IfcFileWithVersions[] = [
    {
      file: f,
      versions: [v],
      latestVersion: v,
      latestVersionId: v.id,
      versionCount: 1,
    },
  ];
  return {
    buildingId: b.id,
    ifcFileId: f.id,
    ifcVersionId: v.id,
    storeys: s,
    files,
  };
}

describe("<LevelChecklistPopover>", () => {
  beforeEach(async () => {
    await resetDb("LevelChecklistPopover");
  });

  it("renders the popover with one row per storey, grouped by IFC", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("Ground")).toBeInTheDocument();
      expect(screen.getByText("First Floor")).toBeInTheDocument();
      expect(screen.getByText("model.ifc")).toBeInTheDocument();
    });
  });

  it("seeds initial state from Dexie (explicit unchecked rows stay unchecked)", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    // Pre-write a "checked=false" override for the first storey.
    await putBuildingLevelSelection({
      buildingId,
      levelId: storeys[0].id,
      selected: false,
    });
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      const groundCheckbox = screen.getByLabelText("Toggle Ground");
      expect((groundCheckbox as HTMLInputElement).checked).toBe(false);
      const firstCheckbox = screen.getByLabelText("Toggle First Floor");
      expect((firstCheckbox as HTMLInputElement).checked).toBe(true);
    });
  });

  it("Apply writes the explicit unchecks to Dexie", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={() => {}}
      />,
    );
    const groundCheckbox = await screen.findByLabelText("Toggle Ground");
    await act(async () => {
      fireEvent.click(groundCheckbox);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("level-popover-apply"));
    });
    await waitFor(async () => {
      const rows = await listBuildingLevelSelections(buildingId);
      const map = new Map(rows.map((r) => [r.levelId, r.selected]));
      expect(map.get(storeys[0].id)).toBe(false);
      // First Floor had no row and stays default-checked; we don't
      // write a row for it.
      expect(map.get(storeys[1].id)).toBeUndefined();
    });
  });

  it("Cancel discards changes and does not write to Dexie", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    const onClose = vi.fn();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={onClose}
      />,
    );
    const groundCheckbox = await screen.findByLabelText("Toggle Ground");
    await act(async () => {
      fireEvent.click(groundCheckbox);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("level-popover-cancel"));
    });
    const rows = await listBuildingLevelSelections(buildingId);
    expect(rows).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it("toggling the group header toggles all rows in the group", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={() => {}}
      />,
    );
    const groupCheckbox = await screen.findByLabelText(
      "Toggle all levels in model.ifc",
    );
    // Initially all checked. Click → uncheck all.
    await act(async () => {
      fireEvent.click(groupCheckbox);
    });
    const ground = screen.getByLabelText("Toggle Ground") as HTMLInputElement;
    const first = screen.getByLabelText(
      "Toggle First Floor",
    ) as HTMLInputElement;
    expect(ground.checked).toBe(false);
    expect(first.checked).toBe(false);
  });

  it("renders an empty-state message when there are no storeys", async () => {
    const { buildingId, files } = await makeSeed();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={[]}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByText(/No storeys loaded yet/),
      ).toBeInTheDocument();
    });
  });
});

describe("<LevelChecklistPopover> Apply syncs extractedStoreys (Task 4)", () => {
  beforeEach(async () => {
    await resetDb("LevelChecklistPopover.Task4");
  });

  it("Apply syncs extractedStoreys to the effective selection", async () => {
    const { buildingId, files, storeys } = await makeSeed();
    render(
      <LevelChecklistPopover
        open={true}
        buildingId={buildingId}
        files={files}
        storeys={storeys}
        onClose={() => {}}
      />,
    );
    // Wait for the popover's draft to seed from Dexie (it's an
    // async effect; the checkbox is only meaningful once seeded).
    const groundCheckbox = await screen.findByLabelText("Toggle Ground");
    await waitFor(() => {
      expect((groundCheckbox as HTMLInputElement).checked).toBe(true);
    });
    // Uncheck Ground, keep First Floor checked, Apply.
    await act(async () => {
      fireEvent.click(groundCheckbox);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("level-popover-apply"));
    });

    // The popover's handleApply awaits setMany() and then
    // syncExtractedStoreys() before onClose(). Wait for the writes
    // to land (fire-and-await) before asserting.
    await waitFor(async () => {
      const extracted = await listExtracted(buildingId);
      const storeyIds = new Set(extracted.map((r) => r.storeyId));
      expect(storeyIds.has(storeys[0].id)).toBe(false); // Ground unchecked
      expect(storeyIds.has(storeys[1].id)).toBe(true); // First Floor still checked
      expect(extracted).toHaveLength(1);
    });
  });
});

describe("<LevelChecklistPopover> closed (wave 64 render-loop fix)", () => {
  it("settles while closed and the selection live query is still pending", async () => {
    // Before the fix: the closed branch set a fresh `{}` draft on every
    // run and `rows` defaulted to a fresh `[]` until Dexie resolved, so
    // the effect re-ran forever and starved the event loop.
    let renders = 0;
    function Counted() {
      renders += 1;
      return (
        <LevelChecklistPopover
          open={false}
          buildingId="b-pending"
          files={[]}
          storeys={[]}
          onClose={() => undefined}
        />
      );
    }
    render(<Counted />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(renders).toBeLessThan(10);
  });
});
