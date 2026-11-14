// Wave 63: an active custom filter that matches nothing is skipped by
// the resolver (so it would not hide everything) — the tree must say
// "0 matches" instead of looking like it silently did nothing.
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { buildInvertedIndex } from "@ff/viewer-react";

import CustomFilterSection from "../../src/components/CustomFilterSection";
import { usePropertyIndexStore } from "../../src/propertyIndexStore";
import type { FilterPreset, FilterState, UserFilterGroup } from "../../src/modelsToolStore";

const preset = (value: string): FilterPreset => ({
  id: `p-${value}`,
  name: value,
  combinator: "AND",
  groups: [
    {
      id: "g",
      combinator: "AND",
      rules: [{ id: "r", property: "_IfcClass", operator: "equals", value }],
    },
  ],
});

function tree(): UserFilterGroup[] {
  return [
    {
      id: "folder",
      kind: "user",
      label: "Filters",
      parentId: null,
      expanded: true,
      children: [
        { id: "walls", kind: "filter", label: "Walls", parentId: "folder", preset: preset("IFCWALL") },
        { id: "doors", kind: "filter", label: "Doors", parentId: "folder", preset: preset("IFCDOOR") },
      ],
    },
  ];
}

function filters(active: string[]): FilterState {
  return {
    auto: {
      models: { enabled: new Set(), hidden: new Set() },
      levels: { enabled: new Set(), hidden: new Set() },
      expanded: { models: true, levels: false },
    },
    customTree: tree(),
    customActive: new Map([["folder", new Set(active)]]),
    customHidden: new Map(),
  };
}

const noop = (): void => undefined;

function renderSection(active: string[]) {
  return render(
    <CustomFilterSection
      tree={tree()}
      filters={filters(active)}
      onCreateFolder={noop}
      onCreateFilter={noop}
      toggleCustomExpanded={noop}
      setCustomFilterActive={noop}
      setCustomFilterHidden={noop}
      renameCustom={noop}
      deleteCustom={noop}
    />,
  );
}

describe("custom filter '0 matches' state", () => {
  beforeEach(() => {
    usePropertyIndexStore.setState({
      indices: new Map([
        ["m", buildInvertedIndex([{ localId: 1, properties: { _IfcClass: "IFCWALL" } }])],
      ]),
      allLocalIds: new Map([["m", new Set([1])]]),
    });
  });

  it("flags an active filter that matches nothing", () => {
    renderSection(["walls", "doors"]);
    expect(screen.getByTestId("custom-leaf-doors-zero-matches")).toHaveTextContent("0 matches");
    expect(screen.queryByTestId("custom-leaf-walls-zero-matches")).toBeNull();
  });

  it("does not flag inactive filters", () => {
    renderSection([]);
    expect(screen.queryByTestId("custom-leaf-doors-zero-matches")).toBeNull();
  });

  it("does not flag anything before the property index exists", () => {
    usePropertyIndexStore.setState({ indices: new Map(), allLocalIds: new Map() });
    renderSection(["doors"]);
    expect(screen.queryByTestId("custom-leaf-doors-zero-matches")).toBeNull();
  });
});
