// w68 regression: the properties panel must show the PICKED ELEMENT's
// class (from its item data `_IfcClass`), not the file-level catalog
// list whose first sorted entry is always "IfcBuilding".
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import { flattenItemData, type IfcViewerHandle } from "@ff/viewer-react";

import PropertiesDrawer from "../../src/components/PropertiesDrawer";
import { useModelsToolStore } from "../../src/modelsToolStore";
import type { ViewerToolsDataSource } from "../../src/dataSource";
import { testDataSource } from "../support/testDb";
import { renderWithDataSource } from "../support/renderWithDataSource";

const CLASSES = ["IfcBuilding", "IfcDoor", "IfcFurnishingElement", "IfcWall"];
const ds: ViewerToolsDataSource = {
  ...testDataSource,
  queryFileName: async () => "ARCH.ifc",
  queryPropertyCatalog: async () =>
    CLASSES.map((c) => ({ pset: "_IfcClass", name: c })) as never,
};

function viewerFor(category: string) {
  const data = flattenItemData({
    _category: { value: category },
    Name: { value: "Thing" },
    IsDefinedBy: [
      {
        Name: { value: "Pset_WallCommon" },
        HasProperties: [
          { Name: { value: "FireRating" }, NominalValue: { value: "2HR" } },
        ],
      },
    ],
  } as never);
  const handle = {
    setOnElementPick: vi.fn(),
    getElementData: vi.fn(async () => data),
  };
  return { current: handle } as unknown as RefObject<IfcViewerHandle>;
}

describe("PropertiesDrawer element class", () => {
  beforeEach(() => useModelsToolStore.getState().clearSelection());

  it("titles with the element class and psets, not IfcBuilding", async () => {
    renderWithDataSource(
      <PropertiesDrawer viewerRef={viewerFor("IFCWALL")} variant="body" />,
      { dataSource: ds },
    );
    await act(async () => {
      useModelsToolStore.getState().selectElement({ modelId: "m", expressId: 77 });
    });
    const meta = await screen.findByTestId("properties-meta");
    await vi.waitFor(() => expect(meta.textContent).toContain("IfcWall (#77)"));
    expect(meta.textContent).not.toContain("IfcBuilding");
    const classes = await screen.findByTestId("properties-drawer-classes");
    expect(classes.textContent).toBe("IfcWall");
    expect(screen.getByTestId("properties-drawer-psets").textContent).toContain(
      "FireRating",
    );
  });
});
