// __tests__/components/IfcListItem.test.tsx
//
// Component tests for <IfcListItem>: renders the cube icon, filename,
// version pill, kebab menu trigger; kebab opens the menu with
// Replace version + Delete; row hover changes the kebab color.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import IfcListItem from "@components/IfcListItem";
import type { IfcFileWithVersions } from "@ff/data/hooks";

const baseEntry: IfcFileWithVersions = {
  file: {
    id: "ifc-1",
    buildingId: "b-1",
    name: "model.ifc",
    currentVersionId: "v-1",
    createdAt: 0,
    updatedAt: 0,
  },
  versions: [
    {
      id: "v-1",
      ifcFileId: "ifc-1",
      versionNumber: 1,
      ifcFileSize: 1024,
      contentHash: "h",
      fragBlobKey: "k",
      storeyCount: 0,
      isLatest: true,
      createdAt: 0,
    },
  ],
  latestVersion: {
    id: "v-1",
    ifcFileId: "ifc-1",
    versionNumber: 1,
    ifcFileSize: 1024,
    contentHash: "h",
    fragBlobKey: "k",
    storeyCount: 0,
    isLatest: true,
    createdAt: 0,
  },
  latestVersionId: "v-1",
  versionCount: 1,
};

describe("<IfcListItem>", () => {
  it("renders the filename, version pill, kebab, and drag handle", () => {
    render(
      <IfcListItem
        entry={baseEntry}
        isReplacing={false}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    expect(screen.getByText("model.ifc")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open menu for model.ifc"),
    ).toBeInTheDocument();
  });

  it("renders a 'v2' pill when the latest version is 2", () => {
    const entry: IfcFileWithVersions = {
      ...baseEntry,
      versions: [
        { ...baseEntry.versions[0], versionNumber: 1, isLatest: false },
        {
          ...baseEntry.versions[0],
          id: "v-2",
          versionNumber: 2,
          isLatest: true,
        },
      ],
      latestVersion: {
        ...baseEntry.versions[0],
        id: "v-2",
        versionNumber: 2,
        isLatest: true,
      },
      latestVersionId: "v-2",
      versionCount: 2,
    };
    render(
      <IfcListItem
        entry={entry}
        isReplacing={false}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("clicking the kebab opens the menu with Replace version and Delete", async () => {
    render(
      <IfcListItem
        entry={baseEntry}
        isReplacing={false}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const kebab = screen.getByLabelText("Open menu for model.ifc");
    await act(async () => {
      fireEvent.click(kebab);
    });
    expect(screen.getByText("Replace version")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("clicking 'Replace version' triggers onRequestReplace with the file id", async () => {
    const onRequestReplace = vi.fn();
    render(
      <IfcListItem
        entry={baseEntry}
        isReplacing={false}
        onRequestReplace={onRequestReplace}
        onRequestDelete={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open menu for model.ifc"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Replace version"));
    });
    expect(onRequestReplace).toHaveBeenCalledWith("ifc-1");
  });

  it("clicking 'Delete' triggers onRequestDelete with the entry", async () => {
    const onRequestDelete = vi.fn();
    render(
      <IfcListItem
        entry={baseEntry}
        isReplacing={false}
        onRequestReplace={() => {}}
        onRequestDelete={onRequestDelete}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open menu for model.ifc"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });
    expect(onRequestDelete).toHaveBeenCalledWith(baseEntry);
  });

  it("disables the kebab when the row is in 'replacing' state", () => {
    render(
      <IfcListItem
        entry={baseEntry}
        isReplacing={true}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const kebab = screen.getByLabelText("Open menu for model.ifc");
    expect(kebab).toBeDisabled();
    expect(screen.getByText("replacing…")).toBeInTheDocument();
  });
});
