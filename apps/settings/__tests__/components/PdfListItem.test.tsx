// __tests__/components/PdfListItem.test.tsx
//
// Component tests for <PdfListItem>: renders the PDF icon,
// filename, version pill, kebab menu trigger; kebab opens the
// menu with Replace version + Delete; row click fires
// `onActivate` with the latest version id; row double-click
// does the same (redundant path).

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import PdfListItem from "@components/PdfListItem";
import type { PdfFileWithVersions } from "@hooks/usePdfFiles";

const baseEntry: PdfFileWithVersions = {
  file: {
    id: "pdf-1",
    buildingId: "b-1",
    name: "Planta 1.pdf",
    createdAt: 0,
    updatedAt: 0,
  },
  versions: [
    {
      id: "v-1",
      pdfFileId: "pdf-1",
      versionNumber: 1,
      name: "Planta 1.pdf",
      size: 1024,
      contentHash: "h",
      pageCount: 1,
      width: 612,
      height: 792,
      storedAt: 0,
      blobKey: "k",
      isLatest: true,
    },
  ],
  latestVersion: {
    id: "v-1",
    pdfFileId: "pdf-1",
    versionNumber: 1,
    name: "Planta 1.pdf",
    size: 1024,
    contentHash: "h",
    pageCount: 1,
    width: 612,
    height: 792,
    storedAt: 0,
    blobKey: "k",
    isLatest: true,
  },
  latestVersionId: "v-1",
  versionCount: 1,
};

describe("<PdfListItem>", () => {
  it("renders the filename, version pill, kebab, and drag handle", () => {
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={() => {}}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    expect(screen.getByText("Planta 1.pdf")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Open menu for Planta 1.pdf"),
    ).toBeInTheDocument();
  });

  it("renders a 'v2' pill when the latest version is 2", () => {
    const entry: PdfFileWithVersions = {
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
      <PdfListItem
        entry={entry}
        isReplacing={false}
        onActivate={() => {}}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("row click fires onActivate with the latest version id", () => {
    const onActivate = vi.fn();
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={onActivate}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const row = screen.getByTestId("pdf-list-item");
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledWith("v-1");
  });

  it("row double-click fires onActivate (redundant path)", () => {
    const onActivate = vi.fn();
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={onActivate}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const row = screen.getByTestId("pdf-list-item");
    fireEvent.doubleClick(row);
    expect(onActivate).toHaveBeenCalledWith("v-1");
  });

  it("does NOT fire onActivate while the row is in 'replacing' state", () => {
    const onActivate = vi.fn();
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={true}
        onActivate={onActivate}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const row = screen.getByTestId("pdf-list-item");
    fireEvent.click(row);
    expect(onActivate).not.toHaveBeenCalled();
    expect(screen.getByText("replacing…")).toBeInTheDocument();
  });

  it("kebab opens the menu with Replace version + Delete", async () => {
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={() => {}}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const kebab = screen.getByLabelText("Open menu for Planta 1.pdf");
    await act(async () => {
      fireEvent.click(kebab);
    });
    expect(screen.getByText("Replace version")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("kebab 'Replace version' fires onRequestReplace with the file id", async () => {
    const onRequestReplace = vi.fn();
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={() => {}}
        onRequestReplace={onRequestReplace}
        onRequestDelete={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open menu for Planta 1.pdf"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Replace version"));
    });
    expect(onRequestReplace).toHaveBeenCalledWith("pdf-1");
  });

  it("kebab 'Delete' fires onRequestDelete with the entry", async () => {
    const onRequestDelete = vi.fn();
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={false}
        onActivate={() => {}}
        onRequestReplace={() => {}}
        onRequestDelete={onRequestDelete}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open menu for Planta 1.pdf"));
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Delete"));
    });
    expect(onRequestDelete).toHaveBeenCalledWith(baseEntry);
  });

  it("disables the kebab when the row is in 'replacing' state", () => {
    render(
      <PdfListItem
        entry={baseEntry}
        isReplacing={true}
        onActivate={() => {}}
        onRequestReplace={() => {}}
        onRequestDelete={() => {}}
      />,
    );
    const kebab = screen.getByLabelText("Open menu for Planta 1.pdf");
    expect(kebab).toBeDisabled();
  });
});
