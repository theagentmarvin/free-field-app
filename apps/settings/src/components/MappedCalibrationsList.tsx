// src/components/MappedCalibrationsList.tsx
//
// Renders the Mapped sub-tab content for the PDF sidebar:
// one row per PDF file that has at least one calibration,
// each row expandable to show per-level sub-rows. The list is
// sourced from the live query `useCalibrationsForProject`,
// pre-indexed by pdfFileId so we don't do N×M lookups per
// render.
//
// Empty state (no calibrations yet): the parent renders a
// different empty-state message ("Mapping PDFs to levels
// arrives in Step 2") when the byPdfFileId map is empty.
//
// Click behavior:
//   - File row click: opens the PDF in the right panel via
//     `setActivePdfVersionId(latestVersion.id)`. Mirrors the
//     behavior of the regular PDF file row in the Unmapped
//     section (the user expects "click to open" everywhere).
//   - Sub-row click: deletes the calibration (with confirm).
//     We chose delete-on-row-click for the MVP to keep the UI
//     minimal. A future "edit / re-calibrate" button can be
//     added without a schema change.
//
// See docs/TASK-12a-CALIBRATION-WIZARD.md "Map sub-tab + Mapped
// section" for the design rationale.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useState,
} from "react";

import { useCalibrationsForProject } from "@hooks/useCalibrations";
import { usePdfFiles } from "@hooks/usePdfFiles";
import { useViewerStore } from "@store/useViewerStore";
import { deleteCalibration } from "@ff/data/db/tables/calibrations";

import Badge from "./Badge";
import ConfirmDialog from "./ConfirmDialog";

export interface MappedCalibrationsListProps {
  projectId: string | null;
  buildingId: string | null;
}

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flexShrink: 0,
  background: "var(--ff-bg-app)",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: "var(--ff-row-height)",
  padding: "0 var(--ff-row-px)",
  borderBottom: "1px solid var(--ff-divider)",
  fontSize: 14,
  color: "var(--ff-text-primary)",
  cursor: "pointer",
};

const expandedChevronStyle = (open: boolean): CSSProperties => ({
  width: 12,
  height: 12,
  transform: open ? "rotate(90deg)" : "rotate(0deg)",
  transition: "transform 150ms ease",
  color: "var(--ff-text-muted)",
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
});

const nameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const subRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: 32,
  padding: "0 var(--ff-row-px)",
  paddingLeft: "calc(var(--ff-row-px) + 18px)",
  borderBottom: "1px solid var(--ff-divider)",
  background: "var(--ff-bg-app)",
  fontSize: 13,
  color: "var(--ff-text-primary)",
  cursor: "pointer",
};

const subRowNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const deleteBtnStyle: CSSProperties = {
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 3,
  border: "1px solid var(--ff-border)",
  background: "transparent",
  color: "var(--ff-text-muted)",
  fontSize: 14,
  cursor: "pointer",
};

const emptyStyle: CSSProperties = {
  padding: "12px 16px",
  fontSize: 12,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};

function ChevronGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export default function MappedCalibrationsList({
  projectId,
  buildingId,
}: MappedCalibrationsListProps): ReactNode {
  const { byPdfFileId, isLoading } = useCalibrationsForProject(projectId);
  const files = usePdfFiles(buildingId);
  const setActivePdfVersionId = useViewerStore(
    (s) => s.setActivePdfVersionId,
  );

  // Track which file rows are expanded. The map keys are
  // pdfFileId. Default: collapsed. The user can click the
  // chevron to toggle.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Confirm-delete state. We always show the confirm before
  // destroying a calibration — even though calibrations are
  // re-creatable, the user might have spent a few minutes
  // picking the points and a stray click would be annoying.
  const [deleteTarget, setDeleteTarget] = useState<{
    calibrationId: string;
    pdfFileName: string;
    storeyName: string;
  } | null>(null);

  const toggle = useCallback((pdfFileId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(pdfFileId)) {
        next.delete(pdfFileId);
      } else {
        next.add(pdfFileId);
      }
      return next;
    });
  }, []);

  // Build the rows. We iterate the byPdfFileId map directly —
  // the live query already filters to rows whose
  // `[projectId+pdfFileId]` compound index matches the active
  // project.
  const rows = Array.from(byPdfFileId.entries()).map(
    ([pdfFileId, calibrations]) => {
      // Find the matching PdfFileRecord so we can show the
      // filename. The buildingId-scoped list is a superset of
      // the calibrations' PDFs in practice, but we defend
      // against "calibration for a file the user already
      // deleted" by looking the name up from the calibration
      // row's project + falling back to the id.
      const file = files.find((f) => f.file.id === pdfFileId);
      const fileName = file?.file.name ?? `(unknown file ${pdfFileId})`;
      // The latest version id — used by the row-click handler
      // to open the PDF. Same shape as the Unmapped rows.
      const latestVersion = file?.latestVersion ?? null;
      const isExpanded = expanded.has(pdfFileId);
      return (
        <div key={pdfFileId} data-testid="mapped-row" data-pdf-file-id={pdfFileId}>
          <div
            style={rowStyle}
            onClick={() => {
              if (latestVersion) setActivePdfVersionId(latestVersion.id);
            }}
            data-testid="mapped-row-header"
            data-pdf-name={fileName}
            data-calibration-count={calibrations.length}
          >
            <span
              style={expandedChevronStyle(isExpanded)}
              onClick={(e) => {
                e.stopPropagation();
                toggle(pdfFileId);
              }}
              data-testid="mapped-row-chevron"
              data-expanded={isExpanded ? "true" : "false"}
            >
              <ChevronGlyph />
            </span>
            <span style={nameStyle} title={fileName}>
              {fileName}
            </span>
            <Badge count={calibrations.length} />
          </div>
          {isExpanded ? (
            <div data-testid="mapped-row-children">
              {calibrations.map((c) => (
                <div
                  key={c.id}
                  style={subRowStyle}
                  data-testid="mapped-subrow"
                  data-calibration-id={c.id}
                  data-storey-name={c.storeyName}
                >
                  <span style={subRowNameStyle} title={c.storeyName}>
                    {c.storeyName}
                  </span>
                  <button
                    type="button"
                    style={deleteBtnStyle}
                    data-testid="mapped-subrow-delete"
                    aria-label={`Delete calibration for ${c.storeyName}`}
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget({
                        calibrationId: c.id,
                        pdfFileName: fileName,
                        storeyName: c.storeyName,
                      });
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      );
    },
  );

  if (isLoading) {
    return (
      <div
        style={emptyStyle}
        data-testid="mapped-list-loading"
      >
        Loading…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        style={emptyStyle}
        data-testid="mapped-list-empty"
      >
        No mappings yet. Click Map on a PDF row below to start.
      </div>
    );
  }

  return (
    <div
      style={wrapperStyle}
      data-testid="mapped-list"
      data-row-count={rows.length}
    >
      {rows}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete calibration"
        message={
          deleteTarget
            ? `Delete the calibration of ${deleteTarget.pdfFileName} for ${deleteTarget.storeyName}? You can re-create it with the Map button.`
            : null
        }
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!deleteTarget) return;
          const id = deleteTarget.calibrationId;
          setDeleteTarget(null);
          await deleteCalibration(id);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
