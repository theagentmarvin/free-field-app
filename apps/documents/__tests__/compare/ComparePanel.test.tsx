import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { db } from "@ff/data/db/database";
import type { PdfFileRecord, PdfVersionRecord } from "@ff/types";

import { useModelsToolStore } from "../../../../packages/ff-viewer-tools/src/modelsToolStore";
import ComparePanel from "../../src/compare/ui/ComparePanel";
import { useCompareStore } from "../../src/compare/compareStore";
import { fakeRunner, makeResult, sideA, sideB } from "./fixtures";

async function seed() {
  if (!db.isOpen()) await db.open();
  await db.transaction("rw", db.tables, async () => {
    await Promise.all(db.tables.map((t) => t.clear()));
  });
  await db.buildings.add({
    id: "b1",
    projectId: "default-project",
    name: "Tower",
    createdAt: 1,
    updatedAt: 1,
    metadata: {},
  });
  const file: PdfFileRecord = { id: "f1", buildingId: "b1", name: "plan.pdf", createdAt: 1, updatedAt: 1 };
  await db.pdfFiles.add(file);
  const v = (n: number, pageCount: number): PdfVersionRecord => ({
    id: `f1-v${n}`,
    pdfFileId: "f1",
    versionNumber: n,
    name: "plan.pdf",
    size: 1,
    contentHash: `h${n}`,
    pageCount,
    width: 595,
    height: 842,
    storedAt: Date.UTC(2026, 10, 20 + n),
    blobKey: `k${n}`,
    isLatest: n === 2,
  });
  await db.pdfVersions.bulkAdd([v(1, 3), v(2, 3)]);
  useModelsToolStore.setState({ activeBuildingId: "b1" });
}

beforeEach(async () => {
  useCompareStore.getState().close();
  await seed();
});

describe("ComparePanel", () => {
  it("renders pickers from seeded data with the prefilled sides", async () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    render(<ComparePanel runner={fakeRunner()} />);
    const baseVer = (await screen.findByTestId("documents-compare-base-version")) as HTMLSelectElement;
    await waitFor(() => expect(baseVer.options.length).toBe(2));
    expect(baseVer.value).toBe("f1-v1");
    expect(baseVer.options[0]!.textContent).toMatch(/^v1 · \d{2} \w{3} 2026$/);
    expect((screen.getByTestId("documents-compare-revision-version") as HTMLSelectElement).value).toBe("f1-v2");
    expect((screen.getByTestId("documents-compare-base-doc") as HTMLSelectElement).value).toBe("f1");
  });

  it("clamps the page to the page count and swaps sides", async () => {
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    render(<ComparePanel runner={fakeRunner()} />);
    await waitFor(() => expect(screen.getByTestId("documents-compare-base-version")).toBeInTheDocument());
    await waitFor(() =>
      expect((screen.getByTestId("documents-compare-base-version") as HTMLSelectElement).options.length).toBe(2),
    );
    fireEvent.change(screen.getByTestId("documents-compare-base-page"), { target: { value: "99" } });
    expect(useCompareStore.getState().base?.page).toBe(3);
    fireEvent.change(screen.getByTestId("documents-compare-base-page"), { target: { value: "0" } });
    expect(useCompareStore.getState().base?.page).toBe(1);
    fireEvent.click(screen.getByTestId("documents-compare-swap"));
    expect(useCompareStore.getState().base?.pdfVersionId).toBe("f1-v2");
  });

  it("auto-runs after the debounce and lists changes with selection and reviewed count", async () => {
    const runner = vi.fn(fakeRunner());
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    render(<ComparePanel runner={runner} />);
    await waitFor(() => expect(screen.getByTestId("documents-compare-summary")).toBeInTheDocument(), { timeout: 3000 });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("documents-compare-summary")).toHaveTextContent("3 changes · 0 reviewed");
    expect(screen.getByTestId("documents-compare-kind-1")).toHaveTextContent("Added");
    expect(screen.getByTestId("documents-compare-kind-2")).toHaveTextContent("Removed");
    expect(screen.getByTestId("documents-compare-kind-3")).toHaveTextContent("Modified");
    expect(screen.getByTestId("documents-compare-row-1")).toHaveTextContent("12 × 8 pt");

    fireEvent.click(screen.getByTestId("documents-compare-row-2"));
    expect(useCompareStore.getState().selectedRegionId).toBe(2);
    expect(screen.getByTestId("documents-compare-row-2")).toHaveAttribute("aria-current", "true");

    fireEvent.click(screen.getByTestId("documents-compare-reviewed-2"));
    // ticking does not change the selection
    expect(useCompareStore.getState().selectedRegionId).toBe(2);
    expect(screen.getByTestId("documents-compare-summary")).toHaveTextContent("3 changes · 1 reviewed");

    fireEvent.click(screen.getByTestId("documents-compare-next"));
    expect(useCompareStore.getState().selectedRegionId).toBe(3);
    fireEvent.click(screen.getByTestId("documents-compare-next"));
    expect(useCompareStore.getState().selectedRegionId).toBe(1);
  });

  it("shows notices for offset, rescale, downscale and no differences", () => {
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        status: "done",
        result: makeResult({
          regions: [],
          offsetPt: { x: 1.5, y: -2 },
          revisionScale: 0.98,
          downscaled: true,
        }),
      });
    });
    render(<ComparePanel runner={fakeRunner()} />);
    for (const id of ["offset", "scale", "downscaled", "none"]) {
      expect(screen.getByTestId(`documents-compare-notice-${id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("documents-compare-notice-none")).toHaveTextContent("No differences found");
  });

  it("labels a manual nudge as a nudge, not auto-align", () => {
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        status: "done",
        settings: { ...useCompareStore.getState().settings, autoAlign: false },
        result: makeResult({ regions: [], offsetPt: { x: -9, y: 6 } }),
      });
    });
    render(<ComparePanel runner={fakeRunner()} />);
    expect(screen.getByTestId("documents-compare-notice-offset")).toHaveTextContent("Revision nudged by -9.0, 6.0 pt");
  });

  it("shows the aspect mismatch notice", () => {
    act(() => {
      useCompareStore.setState({
        active: true,
        base: sideA,
        revision: sideB,
        status: "done",
        result: makeResult({ regions: [], aspectMismatch: true }),
      });
    });
    render(<ComparePanel runner={fakeRunner()} />);
    expect(screen.getByTestId("documents-compare-notice-aspect")).toHaveTextContent("Page proportions differ");
  });

  it("re-selecting the same region bumps the focus nonce", () => {
    const before = useCompareStore.getState().focusNonce;
    useCompareStore.getState().selectRegion(1);
    useCompareStore.getState().selectRegion(1);
    expect(useCompareStore.getState().selectedRegionId).toBe(1);
    expect(useCompareStore.getState().focusNonce).toBe(before + 2);
  });

  it("shows run errors and updates settings", async () => {
    const failing = async () => {
      throw new Error("render failed");
    };
    useCompareStore.getState().open({ base: sideA, revision: sideB });
    render(<ComparePanel runner={failing} />);
    fireEvent.click(screen.getByTestId("documents-compare-settings-toggle"));
    fireEvent.change(screen.getByTestId("documents-compare-dpi"), { target: { value: "144" } });
    expect(useCompareStore.getState().settings.dpi).toBe(144);
    await waitFor(() => expect(screen.getByTestId("documents-compare-error")).toHaveTextContent("render failed"), {
      timeout: 3000,
    });
  });

  it("switches mode and exits compare", () => {
    const onExit = vi.fn();
    useCompareStore.getState().open();
    render(<ComparePanel runner={fakeRunner()} onExit={onExit} />);
    fireEvent.click(screen.getByTestId("documents-compare-mode-overlay"));
    expect(useCompareStore.getState().mode).toBe("overlay");
    fireEvent.click(screen.getByTestId("documents-compare-exit"));
    expect(useCompareStore.getState().active).toBe(false);
    expect(onExit).toHaveBeenCalled();
  });
});
