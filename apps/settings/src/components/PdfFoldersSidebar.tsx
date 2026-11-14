// src/components/PdfFoldersSidebar.tsx
//
// The body of the Folders sub-tab in <PdfSidebarBlock>. Renders:
//   1. A header with the "+ New folder" button.
//   2. A <FolderTree> showing the project-scoped folder hierarchy.
//   3. An "Unfiled" pseudo-folder at the bottom that lists PDFs
//      without any assignment.
//
// All folder mutations (create / rename / delete / nest) live
// here and are wired to the CRUD tables in
// `core/db/tables/pdfFolders.ts`. Per-folder PDF lists are
// rendered inline as collapsible sections so the user can
// confirm "this is the right folder" before activating a PDF.

import { ReactNode, useCallback, useMemo, useRef, useState } from "react";

import { useViewerStore } from "@store/useViewerStore";

import {
  createPdfFolder,
  deletePdfFolder,
  findPdfFolderByName,
  updatePdfFolder,
} from "@ff/data/db/tables/pdfFolders";
import { setAssignmentForPdf } from "@ff/data/db/tables/pdfFolderAssignments";

import { usePdfFiles, type PdfFileWithVersions } from "@hooks/usePdfFiles";
import {
  usePdfFolderTree,
  usePdfFolders,
  usePdfFolderAssignmentsForBuilding,
  usePdfFolderAssignmentsForProject,
} from "@ff/data/hooks";

import FolderTree from "./FolderTree";
import ConfirmDialog from "./ConfirmDialog";
import Popover from "./Popover";

export interface PdfFoldersSidebarProps {
  buildingId: string | null;
  projectId: string;
}

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "8px 12px",
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flexShrink: 0,
};

const newButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 24,
  padding: "0 8px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ff-blue-active)",
  background: "transparent",
  border: "1px solid var(--ff-blue-active)",
  borderRadius: 3,
  cursor: "pointer",
  fontFamily: "var(--ff-font-stack)",
};

const sectionHeaderStyle = (hovered: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 12px",
  paddingLeft: 12,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--ff-text-muted)",
  background: hovered ? "var(--ff-bg-hover)" : "transparent",
  cursor: "pointer",
  userSelect: "none",
});

const newFolderRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 12px",
  paddingLeft: 12,
  background: "var(--ff-bg-hover)",
};

const newFolderInputStyle: React.CSSProperties = {
  flex: 1,
  height: 22,
  padding: "0 8px",
  fontSize: 13,
  border: "1px solid var(--ff-blue-active)",
  borderRadius: 3,
  outline: "none",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

const renameInputStyle: React.CSSProperties = {
  flex: 1,
  height: 22,
  padding: "0 6px",
  fontSize: 13,
  border: "1px solid var(--ff-blue-active)",
  borderRadius: 3,
  outline: "none",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  minHeight: 0,
};

const emptyStyle: React.CSSProperties = {
  padding: "16px",
  fontSize: 12,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};

const pdfRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 12px",
  paddingLeft: 36,
  fontSize: 12,
  color: "var(--ff-text-primary)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

function PlusIcon(): ReactNode {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 150ms ease",
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export default function PdfFoldersSidebar({
  buildingId,
  projectId,
}: PdfFoldersSidebarProps): ReactNode {
  const tree = usePdfFolderTree(projectId);
  const folders = usePdfFolders(projectId);
  const allAssignments = usePdfFolderAssignmentsForProject(projectId);
  const buildingAssignments = usePdfFolderAssignmentsForBuilding(buildingId);

  // Stable empty fallbacks for the live-query hooks — wrap in
  // useMemo so the downstream useMemo consumers see a stable
  // reference when the hook returns undefined (i.e. still
  // hydrating).
  const allAssignmentsStable = useMemo(
    () => allAssignments ?? [],
    [allAssignments],
  );
  const buildingAssignmentsStable = useMemo(
    () => buildingAssignments ?? [],
    [buildingAssignments],
  );

  const files = usePdfFiles(buildingId);
  const setActivePdfVersionId = useViewerStore(
    (s) => s.setActivePdfVersionId,
  );

  // Default: all root folders open. User can collapse.
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(tree.flatMap((n) => collectDescendantIds(n)).concat(tree.map((n) => n.folder.id))),
  );

  // Re-derive openIds defaults when the tree's root set changes
  // (e.g., after a delete). Keep previously-open ids open; add
  // new roots as open.
  const rootIds = useMemo(() => tree.map((n) => n.folder.id).join("|"), [tree]);
  if (openIds.size === 0 && rootIds) {
    setOpenIds(new Set(rootIds.split("|")));
  }

  // Inline new-folder input state. When non-null, renders an
  // input row beneath the tree (and beneath the section the new
  // folder will live under).
  const [newFolderParentId, setNewFolderParentId] = useState<
    string | null | "__root__"
  >(null);
  const [newFolderName, setNewFolderName] = useState("");

  // Inline rename state. When non-null, the row for this folder
  // swaps its name span for an input.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirmation state.
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  // Toggle a folder open/closed.
  const handleToggle = useCallback((folderId: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  // Open the inline new-folder input under a parent (or at the
  // project root when `parentId === "__root__"`).
  const handleNewFolder = useCallback((parentId: string | null) => {
    setNewFolderParentId(parentId === null ? "__root__" : parentId);
    setNewFolderName("");
  }, []);

  // Submit the inline new-folder input.
  const handleSubmitNewFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) {
      setNewFolderParentId(null);
      return;
    }
    const parentId =
      newFolderParentId === "__root__" ? null : newFolderParentId;
    // App-layer uniqueness check — Dexie's compound-unique
    // support can't handle nullable key parts (see database.ts
    // v8 notes), so the CRUD table doesn't enforce this.
    const existing = await findPdfFolderByName(projectId, trimmed, parentId);
    if (existing) {
      // eslint-disable-next-line no-console
      console.warn(
        `[PdfFoldersSidebar] folder "${trimmed}" already exists at this depth`,
      );
      setNewFolderName("");
      setNewFolderParentId(null);
      return;
    }
    await createPdfFolder({
      projectId,
      name: trimmed,
      parentId,
    });
    setNewFolderName("");
    setNewFolderParentId(null);
  }, [newFolderName, newFolderParentId, projectId]);

  // Cancel the inline new-folder input.
  const handleCancelNewFolder = useCallback(() => {
    setNewFolderName("");
    setNewFolderParentId(null);
  }, []);

  // Open the inline rename input for a folder.
  const handleRequestRename = useCallback(
    (folderId: string) => {
      const folder = folders.find((f) => f.id === folderId);
      if (!folder) return;
      setRenamingId(folderId);
      setRenameValue(folder.name);
    },
    [folders],
  );

  // Submit the inline rename input.
  const handleSubmitRename = useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      return;
    }
    const folder = folders.find((f) => f.id === renamingId);
    if (folder) {
      const dup = await findPdfFolderByName(
        projectId,
        trimmed,
        folder.parentId,
      );
      if (dup && dup.id !== renamingId) {
        // eslint-disable-next-line no-console
        console.warn(
          `[PdfFoldersSidebar] folder "${trimmed}" already exists at this depth`,
        );
        setRenamingId(null);
        return;
      }
    }
    await updatePdfFolder(renamingId, { name: trimmed });
    setRenamingId(null);
  }, [renamingId, renameValue, folders, projectId]);

  // Cancel the inline rename input.
  const handleCancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  // Confirm delete (called from <ConfirmDialog>).
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    await deletePdfFolder(id);
  }, [deleteTargetId]);

  // Build the per-folder counts map. Count = number of
  // assignments whose folderId matches. Includes both mapped
  // and unmapped PDFs across all buildings in the project.
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of allAssignmentsStable) {
      map.set(a.folderId, (map.get(a.folderId) ?? 0) + 1);
    }
    return map;
  }, [allAssignmentsStable]);

  // Map of pdfFileId → assigned folderId for the active
  // building. Used to compute "Unfiled" for the current building.
  const assignmentByPdfForBuilding = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of buildingAssignmentsStable) {
      m.set(a.pdfFileId, a.folderId);
    }
    return m;
  }, [buildingAssignmentsStable]);

  // The "Unfiled" list: PDFs in the active building that have no
  // assignment.
  const unfiledFiles = useMemo(
    () => files.filter((f) => !assignmentByPdfForBuilding.has(f.file.id)),
    [files, assignmentByPdfForBuilding],
  );

  // Activate a PDF version (click handler for the per-folder
  // PDF list).
  const handleActivatePdf = useCallback(
    (entry: PdfFileWithVersions) => {
      const latest = entry.latestVersion;
      if (!latest) return;
      setActivePdfVersionId(latest.id);
    },
    [setActivePdfVersionId],
  );

  // Assign a PDF to a folder (or un-file it). Wired into the
  // PDF row's kebab menu in the PDFs sub-tab; called directly
  // here when the user uses the inline move-to-folder menu.
  const handleAssignPdf = useCallback(
    async (pdfFileId: string, folderId: string | null) => {
      await setAssignmentForPdf(pdfFileId, folderId);
    },
    [],
  );

  // Per-folder PDF list: PDFs whose assignment points at this
  // folder, intersected with the active building (if any).
  const filesById = useMemo(() => {
    const m = new Map<string, PdfFileWithVersions>();
    for (const f of files) m.set(f.file.id, f);
    return m;
  }, [files]);

  const pdfsByFolder = useMemo(() => {
    const map = new Map<string, PdfFileWithVersions[]>();
    for (const a of buildingAssignmentsStable) {
      const file = filesById.get(a.pdfFileId);
      if (!file) continue;
      const list = map.get(a.folderId) ?? [];
      list.push(file);
      map.set(a.folderId, list);
    }
    return map;
  }, [buildingAssignmentsStable, filesById]);

  // Per-folder content to render INSIDE the open folder row,
  // beneath the subfolders. Built once per render and passed
  // to <FolderTree> as a `folderExtras` map. Without this, the
  // PDF list would render at the body level (under an "ARCH
  // PDFS" header) — which looks like a sibling folder rather
  // than a sub-section of the folder itself.
  const folderExtras = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const folder of folders) {
      const folderPdfs = pdfsByFolder.get(folder.id) ?? [];
      map.set(
        folder.id,
        <FolderPdfList
          key={folder.id}
          folder={folder}
          pdfs={folderPdfs}
          onActivate={handleActivatePdf}
          onAssign={handleAssignPdf}
          folders={folders.map((f) => ({ id: f.id, name: f.name }))}
        />,
      );
    }
    return map;
  }, [folders, pdfsByFolder, handleActivatePdf, handleAssignPdf]);

  const deleteTarget = folders.find((f) => f.id === deleteTargetId) ?? null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        background: "var(--ff-bg-app)",
      }}
      data-testid="pdf-folders-sidebar"
    >
      <div style={headerStyle}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ff-text-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          Folders
        </span>
        <button
          type="button"
          style={newButtonStyle}
          onClick={() => handleNewFolder(null)}
          aria-label="New top-level folder"
          data-testid="new-root-folder-button"
        >
          <PlusIcon /> New folder
        </button>
      </div>
      <div style={bodyStyle}>
        <FolderTree
          tree={tree}
          counts={counts}
          openIds={openIds}
          onToggle={handleToggle}
          onRequestRename={handleRequestRename}
          onRequestDelete={(id) => setDeleteTargetId(id)}
          onRequestNewSubfolder={(parentId) => handleNewFolder(parentId)}
          folderExtras={folderExtras}
        />
        {newFolderParentId === "__root__" ? (
          <div style={newFolderRowStyle}>
            <input
              type="text"
              autoFocus
              placeholder="Folder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmitNewFolder();
                else if (e.key === "Escape") handleCancelNewFolder();
              }}
              onBlur={() => {
                if (newFolderName.trim()) void handleSubmitNewFolder();
                else handleCancelNewFolder();
              }}
              style={newFolderInputStyle}
              data-testid="new-folder-input"
            />
          </div>
        ) : null}

        {newFolderParentId !== null && newFolderParentId !== "__root__" ? (
          <div style={newFolderRowStyle}>
            <input
              type="text"
              autoFocus
              placeholder="Subfolder name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmitNewFolder();
                else if (e.key === "Escape") handleCancelNewFolder();
              }}
              onBlur={() => {
                if (newFolderName.trim()) void handleSubmitNewFolder();
                else handleCancelNewFolder();
              }}
              style={newFolderInputStyle}
              data-testid="new-subfolder-input"
            />
          </div>
        ) : null}

        {/* Unfiled pseudo-folder (synthetic; not in the real folder tree). */}
        <UnfiledSection
          pdfs={unfiledFiles}
          onActivate={handleActivatePdf}
          onAssign={handleAssignPdf}
          folders={folders}
        />

        {renamingId ? (
          <RenameRow
            folderId={renamingId}
            value={renameValue}
            onChange={setRenameValue}
            onSubmit={handleSubmitRename}
            onCancel={handleCancelRename}
            renameInputStyle={renameInputStyle}
          />
        ) : null}
      </div>
      <ConfirmDialog
        open={deleteTargetId !== null}
        title="Delete folder"
        message={
          deleteTarget
            ? `Delete folder "${deleteTarget.name}"? PDFs in this folder (and any subfolders) will become Unfiled. This cannot be undone.`
            : null
        }
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTargetId(null)}
      />
    </div>
  );
}

function collectDescendantIds(node: {
  folder: { id: string };
  children: { folder: { id: string }; children: unknown[] }[];
}): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    out.push(child.folder.id);
    // The inner call is bounded by the same recursive shape;
    // the type system can't follow it through `unknown[]`, so
    // we widen the cast to keep this helper self-contained.
    out.push(
      ...collectDescendantIds(
        child as {
          folder: { id: string };
          children: { folder: { id: string }; children: unknown[] }[];
        },
      ),
    );
  }
  return out;
}

function FolderPdfList({
  folder,
  pdfs,
  onActivate,
  onAssign,
  folders,
}: {
  folder: { id: string; name: string };
  pdfs: PdfFileWithVersions[];
  onActivate: (entry: PdfFileWithVersions) => void;
  onAssign: (pdfFileId: string, folderId: string | null) => Promise<void>;
  folders: { id: string; name: string }[];
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(true);
  const [menuForPdf, setMenuForPdf] = useState<string | null>(null);
  // The Move button ref drives the Popover's anchor. Keeping
  // the ref local to the row is the simplest way to keep the
  // menu positioned under the right button when there are
  // many rows on screen.
  const moveButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(
    new Map(),
  );
  return (
    <div data-testid="folder-pdf-list" data-folder-id={folder.id}>
      <div
        style={sectionHeaderStyle(hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}>
          <ChevronIcon open={open} />
        </span>
        <span>{folder.name} PDFs</span>
        <span style={{ marginLeft: "auto", fontSize: 11 }}>{pdfs.length}</span>
      </div>
      {open
        ? pdfs.length === 0
          ? <div style={emptyStyle} data-testid="folder-pdf-list-empty">No PDFs in this folder yet.</div>
          : pdfs.map((entry) => (
              <div
                key={entry.file.id}
                style={pdfRowStyle}
                data-testid="folder-pdf-row"
                data-pdf-file-id={entry.file.id}
              >
                <span
                  onClick={() => onActivate(entry)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0,
                    cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  title={entry.file.name}
                >
                  <span style={{
                    width: 12, height: 12, color: "var(--ff-pdf-icon)", flexShrink: 0,
                  }} aria-hidden>
                    <PdfDotIcon />
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.file.name}
                  </span>
                </span>
                <button
                  type="button"
                  ref={(el) => {
                    moveButtonRefs.current.set(entry.file.id, el);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuForPdf(menuForPdf === entry.file.id ? null : entry.file.id);
                  }}
                  aria-label={`Move ${entry.file.name} to another folder`}
                  data-testid="folder-pdf-row-move"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--ff-text-muted)",
                    cursor: "pointer",
                    padding: "0 4px",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Move
                </button>
                {menuForPdf === entry.file.id ? (
                  <Popover
                    open
                    anchor={moveButtonRefs.current.get(entry.file.id) ?? null}
                    placement="below-right"
                    width={200}
                    role="menu"
                    onClose={() => setMenuForPdf(null)}
                    data-testid="assign-menu"
                  >
                    <AssignMenuBody
                      folders={folders}
                      onPick={async (folderId) => {
                        setMenuForPdf(null);
                        await onAssign(entry.file.id, folderId);
                      }}
                    />
                  </Popover>
                ) : null}
              </div>
            ))
        : null}
    </div>
  );
}

function PdfDotIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={12} height={12} fill="currentColor" aria-hidden>
      <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5Z" />
    </svg>
  );
}

function UnfiledSection({
  pdfs,
  onActivate,
  onAssign,
  folders,
}: {
  pdfs: PdfFileWithVersions[];
  onActivate: (entry: PdfFileWithVersions) => void;
  onAssign: (pdfFileId: string, folderId: string | null) => Promise<void>;
  folders: { id: string; name: string }[];
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(true);
  const [menuForPdf, setMenuForPdf] = useState<string | null>(null);
  const moveButtonRefs = useRef<Map<string, HTMLButtonElement | null>>(
    new Map(),
  );
  return (
    <div data-testid="unfiled-section">
      <div
        style={sectionHeaderStyle(hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}>
          <ChevronIcon open={open} />
        </span>
        <span>Unfiled</span>
        <span style={{ marginLeft: "auto", fontSize: 11 }}>{pdfs.length}</span>
      </div>
      {open
        ? pdfs.length === 0
          ? <div style={emptyStyle} data-testid="unfiled-empty">All PDFs are in a folder.</div>
          : pdfs.map((entry) => (
              <div
                key={entry.file.id}
                style={pdfRowStyle}
                data-testid="unfiled-pdf-row"
                data-pdf-file-id={entry.file.id}
              >
                <span
                  onClick={() => onActivate(entry)}
                  style={{
                    display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0,
                    cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}
                  title={entry.file.name}
                >
                  <span style={{
                    width: 12, height: 12, color: "var(--ff-pdf-icon)", flexShrink: 0,
                  }} aria-hidden>
                    <PdfDotIcon />
                  </span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.file.name}
                  </span>
                </span>
                <button
                  type="button"
                  ref={(el) => {
                    moveButtonRefs.current.set(entry.file.id, el);
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuForPdf(menuForPdf === entry.file.id ? null : entry.file.id);
                  }}
                  aria-label={`Assign ${entry.file.name} to a folder`}
                  data-testid="unfiled-pdf-row-assign"
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "var(--ff-text-muted)",
                    cursor: "pointer",
                    padding: "0 4px",
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                  }}
                >
                  Move
                </button>
                {menuForPdf === entry.file.id ? (
                  <Popover
                    open
                    anchor={moveButtonRefs.current.get(entry.file.id) ?? null}
                    placement="below-right"
                    width={200}
                    role="menu"
                    onClose={() => setMenuForPdf(null)}
                    data-testid="assign-menu"
                  >
                    <AssignMenuBody
                      folders={folders}
                      onPick={async (folderId) => {
                        setMenuForPdf(null);
                        await onAssign(entry.file.id, folderId);
                      }}
                    />
                  </Popover>
                ) : null}
              </div>
            ))
        : null}
    </div>
  );
}

function AssignMenuBody({
  folders,
  onPick,
}: {
  folders: { id: string; name: string }[];
  onPick: (folderId: string | null) => void;
}): ReactNode {
  return (
    <>
      <button
        type="button"
        role="menuitem"
        onClick={() => onPick(null)}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          padding: "6px 10px",
          fontSize: 13,
          background: "transparent",
          border: "none",
          borderRadius: 3,
          cursor: "pointer",
          color: "var(--ff-text-muted)",
          fontStyle: "italic",
        }}
        data-testid="assign-menu-unfiled"
      >
        Unfiled (remove)
      </button>
      {folders.length === 0 ? (
        <div style={{ padding: "6px 10px", fontSize: 12, color: "var(--ff-text-muted)" }}>
          No folders yet.
        </div>
      ) : (
        folders.map((f) => (
          <button
            key={f.id}
            type="button"
            role="menuitem"
            onClick={() => onPick(f.id)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "6px 10px",
              fontSize: 13,
              background: "transparent",
              border: "none",
              borderRadius: 3,
              cursor: "pointer",
              color: "var(--ff-text-primary)",
            }}
            data-testid={`assign-menu-folder-${f.id}`}
          >
            {f.name}
          </button>
        ))
      )}
    </>
  );
}

function RenameRow({
  folderId,
  value,
  onChange,
  onSubmit,
  onCancel,
  renameInputStyle,
}: {
  folderId: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
  renameInputStyle: React.CSSProperties;
}): ReactNode {
  return (
    <div style={newFolderRowStyle} data-testid="rename-row" data-folder-id={folderId}>
      <input
        type="text"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void onSubmit();
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => {
          if (value.trim()) void onSubmit();
          else onCancel();
        }}
        style={renameInputStyle}
        data-testid="rename-input"
      />
    </div>
  );
}