// src/components/PdfSidebarBlock.tsx
//
// Bottom half of the sidebar. Renders the PDF sub-tab header row
// (PDFs | Folders | Map) + the upload entry button, the PDF list,
// the per-row kebab / replace / delete flows, and (Task 12a
// Part 2) the Map sub-tab content + the Mapped section's
// populated list.
//
// Task 12a Part 2 updates:
//   - The "Map" sub-tab is now functional. Clicking it switches
//     the body to <MappedCalibrationsList>, which shows the
//     project's calibrations grouped by PDF file.
//   - The "Mapped" section's empty state is replaced by
//     <MappedCalibrationsList> when the user has the PDFs tab
//     open. The legacy "Mapping PDFs to levels arrives in
//     Step 2" copy is gone.
//   - Each Unmapped PDF row has a "Map" button on hover that
//     opens the calibration wizard for that PDF + the
//     currently-open level. Per Maintainer's Q2 (2026-06-02): use
//     `useViewerStore.activeViewId` as the target storey. If
//     no level is open, the button is disabled with a tooltip.
//
// Task 20F updates:
//   - The "Tags" placeholder sub-tab was renamed to "Folders"
//     and now renders <PdfFoldersSidebar> when active. The old
//     "Tags filter is coming soon" copy is gone.
//
// The block is React-strict-mode safe: it uses the existing
// `usePdfPipeline` hook and `usePdfFiles` live query.

import {
  ChangeEvent,
  ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import { useProjectId } from "@ff/auth";
import { isMappablePdf } from "@ff/data";
import { usePdfFiles } from "@hooks/usePdfFiles";
import type { PdfFileWithVersions } from "@hooks/usePdfFiles";
import { usePdfPipeline } from "@hooks/usePdfPipeline";
import { ImportErrorNotice } from "./ImportErrorNotice";
import { useCalibrationsForProject } from "@hooks/useCalibrations";
import { useViewerStore } from "@store/useViewerStore";

import PdfListItem from "./PdfListItem";
import SectionGroupHeader from "./SectionGroupHeader";
import MappedStoreysSection from "./MappedStoreysSection";
import ConfirmDialog from "./ConfirmDialog";
import MappedCalibrationsList from "./MappedCalibrationsList";
import PdfFoldersSidebar from "./PdfFoldersSidebar";
import { BundleImportStatus, BundleImportTrigger, useBundleImport } from "./BundleImportButton";

export interface PdfSidebarBlockProps {
  buildingId: string | null;
}

/** Which sub-tab is active in the body of this block. */
type SubTab = "pdfs" | "folders" | "map";

const blockStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  background: "var(--ff-bg-app)",
  borderBottom: "1px solid var(--ff-border)",
};

const subTabBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  height: 40,
  padding: "0 12px",
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flexShrink: 0,
};

const subTabStyle = (active: boolean, clickable: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  height: 30,
  padding: "0 10px",
  fontSize: 14,
  fontWeight: 600,
  color: active ? "var(--ff-blue-active)" : "var(--ff-text-muted)",
  background: active ? "rgba(37, 99, 235, 0.08)" : "transparent",
  border: active
    ? "1px solid rgba(37, 99, 235, 0.25)"
    : "1px solid transparent",
  borderRadius: 4,
  cursor: clickable ? "pointer" : "default",
  flexShrink: 0,
});

// Boxed 30 x 30 button: the same look as the IFC "+" (UploadButton) and the bundle button.
const addSubTabLabelStyle = (enabled: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  marginLeft: "auto",
  borderRadius: 4,
  border: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: enabled ? "pointer" : "not-allowed",
  opacity: enabled ? 1 : 0.4,
  flexShrink: 0,
});

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  minHeight: 0,
};

const bulkNoteStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  margin: "6px 12px",
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.4,
  color: "var(--ff-text-primary)",
  background: "var(--ff-bg-hover)",
  borderRadius: 6,
};

const bulkDismissStyle: React.CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--ff-text-muted)",
  fontSize: 14,
  lineHeight: 1,
};

const docRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const pageBadgeStyle: React.CSSProperties = {
  flexShrink: 0,
  marginRight: 8,
  padding: "1px 6px",
  fontSize: 11,
  borderRadius: 999,
  border: "1px solid var(--ff-border)",
  color: "var(--ff-text-muted)",
};

const emptyStyle: React.CSSProperties = {
  padding: "16px 16px",
  fontSize: 13,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};

const mapButtonStyle: React.CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 22,
  padding: "0 8px",
  marginRight: 4,
  borderRadius: 3,
  border: "1px solid var(--ff-blue-active)",
  background: "transparent",
  color: "var(--ff-blue-active)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  cursor: "pointer",
  fontFamily: "var(--ff-font-stack)",
};

const mapButtonDisabledStyle: React.CSSProperties = {
  ...mapButtonStyle,
  border: "1px solid var(--ff-border)",
  color: "var(--ff-text-muted)",
  cursor: "not-allowed",
};

function PlusIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** Shared "Open a calibration wizard for this PDF" handler. */
function useStartCalibrationForPdf(): (
  pdfFileId: string,
) => boolean {
  const startCalibration = useViewerStore((s) => s.startCalibration);
  const activeStoreyName = useViewerStore((s) => s.activeStoreyName);
  return useCallback(
    (pdfFileId: string): boolean => {
      if (!activeStoreyName) return false;
      startCalibration(pdfFileId, activeStoreyName);
      return true;
    },
    [startCalibration, activeStoreyName],
  );
}

/** Render a single Unmapped PDF row with a Map button on the
 *  right (next to the kebab). Used to keep PdfListItem simple. */
function PdfRowWithMapButton({
  entry,
  isReplacing,
  onActivate,
  onRequestReplace,
  onRequestDelete,
  onRequestMap,
  canMap,
}: {
  entry: PdfFileWithVersions;
  isReplacing: boolean;
  onActivate: (versionId: string) => void;
  onRequestReplace: (pdfFileId: string) => void;
  onRequestDelete: (entry: PdfFileWithVersions) => void;
  onRequestMap: (pdfFileId: string) => void;
  canMap: boolean;
}): ReactNode {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <PdfListItem
            entry={entry}
            isReplacing={isReplacing}
            onActivate={onActivate}
            onRequestReplace={onRequestReplace}
            onRequestDelete={onRequestDelete}
          />
        </div>
        <button
          type="button"
          style={canMap ? mapButtonStyle : mapButtonDisabledStyle}
          onClick={(e) => {
            e.stopPropagation();
            if (canMap) onRequestMap(entry.file.id);
          }}
          disabled={!canMap}
          data-testid="pdf-list-item-map"
          data-pdf-file-id={entry.file.id}
          aria-label="Map this PDF to the current level"
          title={
            canMap
              ? "Map this PDF to the current level"
              : "Open a level in the 3D view first"
          }
        >
          Map
        </button>
      </div>
    </div>
  );
}

export default function PdfSidebarBlock({
  buildingId,
}: PdfSidebarBlockProps): ReactNode {
  // The PDF list is sourced from Dexie via usePdfFiles.
  const files = usePdfFiles(buildingId);
  const { loadPdfs, replacePdfVersion, deletePdf, error } =
    usePdfPipeline();

  // Live list of calibrations for the active project. Used to
  // split the PDF list into "mapped" (≥1 calibration) and
  // "unmapped" inside the PDFs tab. Empty while no project is chosen.
  const projectId = useProjectId();
  const { byPdfFileId } = useCalibrationsForProject(projectId ?? null);

  const setActivePdfVersionId = useViewerStore(
    (s) => s.setActivePdfVersionId,
  );
  const activeStoreyName = useViewerStore((s) => s.activeStoreyName);
  const startCalibrationForPdf = useStartCalibrationForPdf();

  // Active sub-tab. "PDFs" by default; user can switch to
  // "Folders" to manage PDF groupings or "Map" to see the
  // calibrations list.
  const [activeTab, setActiveTab] = useState<SubTab>("pdfs");

  // Bundle import: the icon button sits next to the "+" (below), status under the tab bar.
  const bundleImport = useBundleImport({
    projectId: projectId ?? null,
    buildingId,
    onImported: (r) => {
      if (r.lastPdfVersionId) setActivePdfVersionId(r.lastPdfVersionId);
    },
  });

  // Chevron state for the three sub-sections in the PDFs tab.
  // The "Unmapped" section's count is `files.length`; "Mapped"
  // is the count of files with at least one calibration.
  const [unmappedOpen, setUnmappedOpen] = useState(true);
  const [mappedOpen, setMappedOpen] = useState(true);
  const [documentsOpen, setDocumentsOpen] = useState(true);

  // Hidden <input type="file"> for both the `+` upload flow
  // AND the kebab "Replace version" flow. Two refs so the two
  // onChange handlers stay disjoint.
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceFileIdRef = useRef<string | null>(null);

  // Replace-state + delete-state mirrors the IFC block.
  const [replacingPdfFileId, setReplacingPdfFileId] = useState<string | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PdfFileWithVersions | null>(
    null,
  );

  // 2026-11-16 — bulk upload: several PDFs at once, imported one at a
  // time with progress, then a summary (imported / failed).
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [bulkSummary, setBulkSummary] = useState<string | null>(null);
  const handleUploadFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      e.target.value = "";
      if (files.length === 0 || !buildingId) return;
      setBulkSummary(null);
      const result = await loadPdfs(files, buildingId, (i, total, name) =>
        setBulkProgress(total > 1 ? `Importing ${i + 1} of ${total} — ${name}` : `Importing ${name}`),
      );
      setBulkProgress(null);
      const last = result.imported[result.imported.length - 1];
      if (last) setActivePdfVersionId(last.versionId);
      if (files.length > 1 || result.failed.length > 0) {
        const ok = `${result.imported.length} of ${files.length} imported`;
        setBulkSummary(
          result.failed.length === 0
            ? ok
            : `${ok}. Failed: ${result.failed.map((f) => `${f.name} (${f.error.message})`).join("; ")}`,
        );
      }
    },
    [buildingId, loadPdfs, setActivePdfVersionId],
  );

  const handleRequestReplace = useCallback((pdfFileId: string) => {
    replaceFileIdRef.current = pdfFileId;
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      const fileId = replaceFileIdRef.current;
      replaceFileIdRef.current = null;
      if (!file || !fileId) return;
      setReplacingPdfFileId(fileId);
      try {
        const result = await replacePdfVersion(fileId, file);
        setActivePdfVersionId(result.versionId);
      } catch {
        // Pipeline surfaces the error.
      } finally {
        setReplacingPdfFileId(null);
      }
    },
    [replacePdfVersion, setActivePdfVersionId],
  );

  const handleRequestDelete = useCallback((entry: PdfFileWithVersions) => {
    setDeleteTarget(entry);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const pdfFileId = deleteTarget.file.id;
    setDeleteTarget(null);
    try {
      await deletePdf(pdfFileId);
    } catch {
      // Pipeline surfaces the error.
    }
  }, [deleteTarget, deletePdf]);

  const handleActivate = useCallback(
    (versionId: string) => {
      setActivePdfVersionId(versionId);
    },
    [setActivePdfVersionId],
  );

  // Map button handler. Requires an active level plan.
  // The MappingView takes over the right panel — no need to
  // also set activePdfVersionId.
  const handleRequestMap = useCallback(
    (pdfFileId: string) => {
      // 2026-11-16 — only single-page plans can be mapped. Documents
      // render no Map button; this guards any other caller.
      const entry = files.find((f) => f.file.id === pdfFileId);
      if (entry && !isMappablePdf(entry.latestVersion)) return;
      const started = startCalibrationForPdf(pdfFileId);
      if (!started) {
        // The button is disabled in this case, but we guard
        // anyway. Future improvement: surface a toast.
        // eslint-disable-next-line no-console
        console.warn(
          "[PdfSidebarBlock] cannot start calibration — no active level",
        );
      }
    },
    [startCalibrationForPdf, files],
  );

  // Split the PDF list by "is mapped" (has ≥1 calibration for the
  // active project) using the live calibrations query. The
  // PdfRowWithMapButton is shared between both sections so the
  // user can re-Map a previously mapped PDF to a different level
  // without leaving the PDFs tab.
  // 2026-11-16 — Plans (single page, mappable) vs Documents
  // (multi-page, never mappable), by the latest version's page count.
  const planFiles = files.filter((entry) => isMappablePdf(entry.latestVersion));
  const documentFiles = files.filter((entry) => !isMappablePdf(entry.latestVersion));
  const unmappedFiles = planFiles.filter(
    (entry) => !byPdfFileId.has(entry.file.id),
  );
  const mappedFiles = planFiles.filter((entry) =>
    byPdfFileId.has(entry.file.id),
  );
  const documentCount = documentFiles.length;
  const fileCount = files.length;
  const unmappedCount = unmappedFiles.length;
  const mappedCount = mappedFiles.length;
  const canUpload = !!buildingId;
  const canMap = activeStoreyName !== null;

  return (
    <section style={blockStyle} aria-label="PDF block">
      <div style={subTabBarStyle} role="tablist" aria-label="PDF sub-tabs">
        <button
          type="button"
          style={subTabStyle(activeTab === "pdfs", true)}
          role="tab"
          aria-selected={activeTab === "pdfs"}
          data-testid="pdf-subtab-pdfs"
          onClick={() => setActiveTab("pdfs")}
        >
          PDFs
        </button>
        <button
          type="button"
          style={subTabStyle(activeTab === "folders", true)}
          role="tab"
          aria-selected={activeTab === "folders"}
          data-testid="pdf-subtab-folders"
          onClick={() => setActiveTab("folders")}
        >
          Folders
        </button>
        <button
          type="button"
          style={subTabStyle(activeTab === "map", true)}
          role="tab"
          aria-selected={activeTab === "map"}
          data-testid="pdf-subtab-map"
          onClick={() => setActiveTab("map")}
        >
          Map
        </button>
        {canUpload ? (
          <label
            htmlFor="pdf-upload-input"
            style={addSubTabLabelStyle(canUpload)}
            data-testid="pdf-upload-trigger"
            aria-label="Upload PDF"
            title="Upload PDF"
          >
            <PlusIcon />
          </label>
        ) : (
          <span
            style={addSubTabLabelStyle(canUpload)}
            aria-hidden
            data-testid="pdf-upload-trigger-disabled"
            title="Select a building first"
          >
            <PlusIcon />
          </span>
        )}
        <BundleImportTrigger state={bundleImport} />
      </div>

      <BundleImportStatus state={bundleImport} />

      {error ? <ImportErrorNotice error={error} testId="pdf-error" /> : null}
      {bulkProgress ? (
        <div style={bulkNoteStyle} data-testid="pdf-bulk-progress" role="status">
          {bulkProgress}
        </div>
      ) : null}
      {bulkSummary ? (
        <div style={bulkNoteStyle} data-testid="pdf-bulk-summary" role="status">
          {bulkSummary}
          <button type="button" style={bulkDismissStyle} aria-label="Dismiss" onClick={() => setBulkSummary(null)}>
            ×
          </button>
        </div>
      ) : null}

      <div style={bodyStyle} data-testid="pdf-list">
        {activeTab === "pdfs" ? (
          <>
            <SectionGroupHeader
              label="Plans · unmapped"
              count={unmappedCount}
              open={unmappedOpen}
              onToggle={() => setUnmappedOpen((v) => !v)}
            />
            {unmappedOpen && (
              <>
                {fileCount === 0 ? (
                  <div style={emptyStyle}>
                    {buildingId
                      ? "No PDF files yet. Click + above to upload PDFs (you can pick several). Single-page PDFs are plans and can be mapped; multi-page PDFs are documents."
                      : "Select or create a building to upload PDF files."}
                  </div>
                ) : unmappedCount === 0 ? (
                  <div style={emptyStyle} data-testid="pdf-unmapped-empty">
                    All plans are mapped. Use the section below to inspect calibrations.
                  </div>
                ) : (
                  unmappedFiles.map((entry) => (
                    <PdfRowWithMapButton
                      key={entry.file.id}
                      entry={entry}
                      isReplacing={replacingPdfFileId === entry.file.id}
                      onActivate={handleActivate}
                      onRequestReplace={handleRequestReplace}
                      onRequestDelete={handleRequestDelete}
                      onRequestMap={handleRequestMap}
                      canMap={canMap}
                    />
                  ))
                )}
              </>
            )}

            <SectionGroupHeader
              label="Plans · mapped"
              count={mappedCount}
              open={mappedOpen}
              onToggle={() => setMappedOpen((v) => !v)}
            />
            {mappedOpen && (
              mappedCount === 0 ? (
                <div style={emptyStyle} data-testid="pdf-mapped-empty">
                  Open the Map sub-tab to see calibrations.
                </div>
              ) : (
                mappedFiles.map((entry) => (
                  <PdfRowWithMapButton
                    key={entry.file.id}
                    entry={entry}
                    isReplacing={replacingPdfFileId === entry.file.id}
                    onActivate={handleActivate}
                    onRequestReplace={handleRequestReplace}
                    onRequestDelete={handleRequestDelete}
                    onRequestMap={handleRequestMap}
                    canMap={canMap}
                  />
                ))
              )
            )}

            <SectionGroupHeader
              label="Documents"
              count={documentCount}
              open={documentsOpen}
              onToggle={() => setDocumentsOpen((v) => !v)}
            />
            {documentsOpen && (
              documentCount === 0 ? (
                <div style={emptyStyle} data-testid="pdf-documents-empty">
                  Multi-page PDFs appear here. They can be read and measured, but not mapped.
                </div>
              ) : (
                documentFiles.map((entry) => (
                  <div key={entry.file.id} style={docRowStyle} data-testid="pdf-document-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <PdfListItem
                        entry={entry}
                        isReplacing={replacingPdfFileId === entry.file.id}
                        onActivate={handleActivate}
                        onRequestReplace={handleRequestReplace}
                        onRequestDelete={handleRequestDelete}
                      />
                    </div>
                    <span
                      style={pageBadgeStyle}
                      data-testid="pdf-document-pages"
                      title="Multi-page documents can't be mapped. Only single-page plans can."
                    >
                      {entry.latestVersion?.pageCount ?? "?"} pp
                    </span>
                  </div>
                ))
              )
            )}

            <MappedStoreysSection buildingId={buildingId} />
          </>
        ) : activeTab === "folders" ? (
          projectId ? (
            <PdfFoldersSidebar buildingId={buildingId} projectId={projectId} />
          ) : null
        ) : activeTab === "map" ? (
          projectId ? (
            <MappedCalibrationsList projectId={projectId} buildingId={buildingId} />
          ) : null
        ) : null}
      </div>

      {/* Hidden file picker for the `+` upload flow. */}
      <input
        ref={uploadInputRef}
        id="pdf-upload-input"
        type="file"
        accept="application/pdf"
        onChange={handleUploadFilePicked}
        multiple
        style={{ display: "none" }}
        data-testid="pdf-upload-input"
      />

      {/* Hidden file picker for the kebab Replace-version flow. */}
      <input
        ref={replaceInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleReplaceFilePicked}
        style={{ display: "none" }}
        data-testid="pdf-replace-input"
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete PDF"
        message={
          deleteTarget
            ? `Delete ${deleteTarget.file.name}? This removes all ${
                deleteTarget.versionCount
              } version${
                deleteTarget.versionCount === 1 ? "" : "s"
              } and any calibrations. This cannot be undone.`
            : null
        }
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </section>
  );
}
