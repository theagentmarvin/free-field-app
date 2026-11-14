// src/components/IfcSidebarBlock.tsx
//
// Bottom half of the sidebar. Renders the IFC sub-tab header row
// (IFC | Get Levels) + the upload entry button, the IFC list, the
// Get Levels popover, and the per-row kebab / replace / delete flows.
//
// The block is React-strict-mode safe: it uses the existing
// `useIfcPipeline` hook (already disposedRef-aware in Task 2) and
// `useIfcFiles` live query. State it owns:
//   - `popoverOpen`: Get Levels popover visibility
//   - `replacingFileId`: which file is mid-replace (so its row shows
//      "replacing…" and is non-interactive)
//   - `deleteTarget`: which file the user has asked to delete
//
// Per docs/TASK-3-UI.md "Acceptance criteria" the popover does NOT
// affect the viewer — Apply just persists to Dexie.

import {
  ChangeEvent,
  ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";

import { useIfcFiles } from "@ff/data/hooks";
import { useIfcPipeline } from "@ff/data/hooks";
import { ImportErrorNotice } from "./ImportErrorNotice";
import { useStoreys } from "@hooks/useStoreys";
import type { IfcFileWithVersions } from "@ff/data/hooks";
import { useViewerStore } from "@store/useViewerStore";
import { useViewerHandle } from "@ff/viewer-react";

import GetLevelsButton from "./GetLevelsButton";
import IfcListItem from "./IfcListItem";
import LevelChecklistPopover from "./LevelChecklistPopover";
import UploadButton from "./UploadButton";
import ConfirmDialog from "./ConfirmDialog";

export interface IfcSidebarBlockProps {
  buildingId: string | null;
}

const blockStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
  background: "var(--ff-bg-app)",
  borderTop: "1px solid var(--ff-border)",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 40,
  padding: "0 12px",
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flexShrink: 0,
};

const subTabIfcStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 30,
  padding: "0 10px",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--ff-blue-active)",
  background: "rgba(37, 99, 235, 0.08)",
  border: "1px solid rgba(37, 99, 235, 0.25)",
  borderRadius: 4,
  flexShrink: 0,
};

const listStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  minHeight: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "16px 16px",
  fontSize: 13,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};

function IfcSubTabBadge(): ReactNode {
  return <span style={subTabIfcStyle}>IFC</span>;
}

export default function IfcSidebarBlock({
  buildingId,
}: IfcSidebarBlockProps) {
  const files = useIfcFiles(buildingId);
  const storeys = useStoreys(buildingId, undefined);
  const {
    loadIfc,
    replaceIfcVersion,
    deleteIfc,
    cancelImport,
    isLoading,
    progress,
    error,
  } = useIfcPipeline();
  // Task 11: clicking an IFC row returns the right panel to the
  // 3D viewer (clears `activePdfVersionId`). We pull the setter
  // here and pass it down as `onClick` on <IfcListItem>.
  const setActivePdfVersionId = useViewerStore(
    (s) => s.setActivePdfVersionId,
  );
  const viewerRef = useViewerHandle();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [replacingFileId, setReplacingFileId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IfcFileWithVersions | null>(
    null,
  );

  // Hidden <input type="file"> for the kebab "Replace version" flow.
  // Re-mounted per replace action to reset its value.
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const replaceFileIdRef = useRef<string | null>(null);

  const handleUpload = useCallback(
    async (picked: File[]) => {
      if (!buildingId) {
        // Defensive: the button is disabled when buildingId is null,
        // so this path should be unreachable from the UI. If it is
        // hit (programmatic misuse), surface a clear log line.
        // eslint-disable-next-line no-console
        console.warn(
          "[IfcSidebarBlock] handleUpload called with no active building",
        );
        return;
      }
      // Sequential: the worker is shared, so concurrent parses will
      // step on each other. The pipeline itself isn't aware of the
      // other loads.
      for (const file of picked) {
        try {
          await loadIfc(file, buildingId);
        } catch (err) {
          // Pipeline also sets its own `error` state (rendered below).
          // We log here too so dev-tools shows which file failed.
          // eslint-disable-next-line no-console
          console.error("[IfcSidebarBlock] loadIfc failed:", file.name, err);
        }
      }
    },
    [buildingId, loadIfc],
  );

  const handleRequestReplace = useCallback((fileId: string) => {
    replaceFileIdRef.current = fileId;
    replaceInputRef.current?.click();
  }, []);

  const handleReplaceFilePicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Always reset the input so the same file can be re-picked.
      e.target.value = "";
      const fileId = replaceFileIdRef.current;
      replaceFileIdRef.current = null;
      if (!file || !fileId) return;
      setReplacingFileId(fileId);
      try {
        await replaceIfcVersion(fileId, file);
      } catch {
        // Pipeline surfaces the error via its own state; we just
        // unblock the row.
      } finally {
        setReplacingFileId(null);
      }
    },
    [replaceIfcVersion],
  );

  const handleRequestDelete = useCallback((entry: IfcFileWithVersions) => {
    setDeleteTarget(entry);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const fileId = deleteTarget.file.id;
    setDeleteTarget(null);
    try {
      await deleteIfc(fileId);
    } catch {
      // Pipeline surfaces the error via its own state.
    }
  }, [deleteTarget, deleteIfc]);

  const fileCount = files.length;
  const latestVersionIds = files
    .map((f) => f.latestVersionId)
    .filter((id) => id.length > 0);
  // For the level popover, scope the storey list to the latest
  // versions we actually have. (useStoreys already returns all
  // storeys in the building if no activeIfcVersionIds is passed, but
  // restricting to latest keeps historic-version storeys out of the
  // "Get Levels" set — those belong to retired versions.)
  const popoverStoreys = latestVersionIds.length > 0
    ? storeys.filter((s) => latestVersionIds.includes(s.ifcVersionId))
    : storeys;

  return (
    <section style={blockStyle} aria-label="IFC block">
      <div style={headerRowStyle}>
        <IfcSubTabBadge />
        <GetLevelsButton
          open={popoverOpen}
          onToggle={() => setPopoverOpen((v) => !v)}
          busy={isLoading}
        />
        <div style={{ marginLeft: "auto" }}>
          <UploadButton
            onFiles={handleUpload}
            busy={isLoading}
            disabled={!buildingId}
            disabledReason={
              buildingId
                ? undefined
                : "Select or create a building first (click + in the header)"
            }
            variant="icon"
            label="Upload IFC files"
          />
        </div>
      </div>

      {error ? <ImportErrorNotice error={error} testId="ifc-error" /> : null}

      {progress ? (
        // Wave 61: the conversion runs in a Web Worker, so this
        // updates live while the UI stays responsive.
        <div
          role="status"
          data-testid="ifc-import-progress"
          style={{
            margin: "8px 12px",
            fontSize: 12,
            color: "#475569",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1 }}>
              {progress.stage === "reading" ? "Reading IFC…" : "Importing IFC…"}{" "}
              {Math.round(progress.fraction * 100)}%
            </span>
            {/* Wave 64 — stop the conversion (the worker is terminated
                and nothing is written). */}
            <button
              type="button"
              data-testid="ifc-import-cancel"
              onClick={cancelImport}
              style={cancelButtonStyle}
            >
              Cancel
            </button>
          </div>
          <div
            style={{
              marginTop: 4,
              height: 3,
              background: "#e2e8f0",
              borderRadius: 2,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.round(progress.fraction * 100)}%`,
                height: "100%",
                background: "#3b82f6",
                transition: "width 150ms linear",
              }}
            />
          </div>
        </div>
      ) : null}

      <div style={listStyle} data-testid="ifc-list">
        {fileCount === 0 ? (
          <div style={emptyStyle}>
            {buildingId
              ? "No IFC files yet. Click + above to upload one."
              : "Select or create a building to upload IFC files."}
          </div>
        ) : (
          files.map((entry) => (
            <IfcListItem
              key={entry.file.id}
              entry={entry}
              isReplacing={replacingFileId === entry.file.id}
              onRequestReplace={handleRequestReplace}
              onRequestDelete={handleRequestDelete}
              onClick={() => {
                setActivePdfVersionId(null);
                viewerRef.current?.closeLevel();
              }}
            />
          ))
        )}
      </div>

      {/* Hidden file picker for the kebab Replace-version flow. */}
      <input
        ref={replaceInputRef}
        type="file"
        accept=".ifc,application/x-step"
        onChange={handleReplaceFilePicked}
        style={{ display: "none" }}
        data-testid="replace-input"
      />

      <LevelChecklistPopover
        open={popoverOpen}
        buildingId={buildingId}
        files={files}
        storeys={popoverStoreys}
        onClose={() => setPopoverOpen(false)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete IFC"
        message={
          deleteTarget
            ? `Delete ${deleteTarget.file.name}? This removes all ${
                deleteTarget.versionCount
              } version${
                deleteTarget.versionCount === 1 ? "" : "s"
              }. This cannot be undone.`
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

const cancelButtonStyle: React.CSSProperties = {
  height: 22,
  padding: "0 8px",
  fontSize: 11,
  borderRadius: 4,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#334155",
  cursor: "pointer",
  fontFamily: "inherit",
};
