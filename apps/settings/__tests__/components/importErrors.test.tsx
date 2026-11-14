// Wave 64 — data-layer signals in the import UI:
//   - StorageQuotaExceededError → "Browser storage is full" (IFC + PDF);
//   - "Importing IFC… N%" has a Cancel button wired to cancelImport();
//   - a user cancel reads as a neutral "Import cancelled." notice.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, type ReactElement } from "react";

const h = vi.hoisted(() => ({
  ifc: {
    progress: null as { stage: string; fraction: number } | null,
    error: null as Error | null,
    cancelImport: (() => undefined) as () => void,
  },
  pdfError: null as Error | null,
}));

// Stable references: fresh arrays / fns per render would re-fire the
// component's effects forever.
const stable = vi.hoisted(() => ({ files: [] as unknown[], noop: async () => undefined }));

vi.mock("@ff/auth", async (orig) => ({
  ...(await orig<typeof import("@ff/auth")>()),
  useProjectId: () => "p-1",
}));

vi.mock("@ff/data/hooks", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIfcFiles: () => stable.files,
  useIfcPipeline: () => ({
    loadIfc: stable.noop,
    replaceIfcVersion: stable.noop,
    deleteIfc: stable.noop,
    cancelImport: h.ifc.cancelImport,
    isLoading: h.ifc.progress !== null,
    progress: h.ifc.progress,
    error: h.ifc.error,
  }),
}));

vi.mock("@hooks/useStoreys", () => ({ useStoreys: () => stable.files }));

vi.mock("@hooks/usePdfPipeline", () => ({
  usePdfPipeline: () => ({
    loadPdf: stable.noop,
    replacePdfVersion: stable.noop,
    deletePdf: stable.noop,
    isLoading: false,
    error: h.pdfError,
  }),
}));

import { StorageQuotaExceededError } from "@ff/data/db/errors";
import IfcSidebarBlock from "@components/IfcSidebarBlock";
import PdfSidebarBlock from "@components/PdfSidebarBlock";
import { ImportErrorNotice, STORAGE_FULL_TITLE } from "@components/ImportErrorNotice";
import { ViewerHandleProvider, type IfcViewerHandle } from "@ff/viewer-react";

function withViewerHandle(ui: ReactElement): ReactElement {
  const ref = createRef<IfcViewerHandle>();
  return <ViewerHandleProvider viewerRef={ref}>{ui}</ViewerHandleProvider>;
}

afterEach(() => {
  cleanup();
  h.ifc.progress = null;
  h.ifc.error = null;
  h.ifc.cancelImport = () => undefined;
  h.pdfError = null;
});

function quotaError(): StorageQuotaExceededError {
  const dom = Object.assign(new Error("QuotaExceededError"), { name: "QuotaExceededError" });
  return new StorageQuotaExceededError(dom);
}

/** Same shape as @ff/data's IfcImportAbortedError("aborted") (the hooks barrel is mocked here). */
function abortError(): Error {
  return Object.assign(new Error("IFC import aborted"), {
    name: "IfcImportAbortedError",
    reason: "aborted",
  });
}

describe("<ImportErrorNotice>", () => {
  it("titles a quota error 'Browser storage is full'", () => {
    render(<ImportErrorNotice error={quotaError()} testId="n" />);
    expect(screen.getByTestId("n")).toHaveAttribute("data-kind", "quota");
    expect(screen.getByTestId("n")).toHaveTextContent(STORAGE_FULL_TITLE);
  });

  it("shows a user cancel as a neutral status", () => {
    render(<ImportErrorNotice error={abortError()} testId="n" />);
    expect(screen.getByTestId("n")).toHaveAttribute("data-kind", "cancelled");
    expect(screen.getByRole("status")).toHaveTextContent("Import cancelled.");
  });

  it("shows other errors verbatim", () => {
    render(<ImportErrorNotice error={new Error("bad IFC header")} testId="n" />);
    expect(screen.getByRole("alert")).toHaveTextContent("bad IFC header");
    expect(screen.getByRole("alert")).not.toHaveTextContent(STORAGE_FULL_TITLE);
  });
});

describe("<IfcSidebarBlock> import signals", () => {
  it("Cancel next to 'Importing IFC… N%' calls cancelImport()", () => {
    const cancel = vi.fn();
    h.ifc.cancelImport = cancel;
    h.ifc.progress = { stage: "converting", fraction: 0.42 };
    render(withViewerHandle(<IfcSidebarBlock buildingId="b1" />));
    expect(screen.getByTestId("ifc-import-progress")).toHaveTextContent("Importing IFC… 42%");
    fireEvent.click(screen.getByTestId("ifc-import-cancel"));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("shows 'Browser storage is full' on a quota failure", () => {
    h.ifc.error = quotaError();
    render(withViewerHandle(<IfcSidebarBlock buildingId="b1" />));
    expect(screen.getByTestId("ifc-error")).toHaveTextContent(STORAGE_FULL_TITLE);
  });
});

describe("<PdfSidebarBlock> import signals", () => {
  it("shows 'Browser storage is full' on a quota failure", () => {
    h.pdfError = quotaError();
    render(withViewerHandle(<PdfSidebarBlock buildingId={null} />));
    expect(screen.getByTestId("pdf-error")).toHaveTextContent(STORAGE_FULL_TITLE);
  });
});
