// src/components/FolderTree.tsx
//
// Collapsible folder tree for the Folders sub-tab. Receives the
// pre-built tree from `usePdfFolderTree` and renders it
// depth-first. Each row carries:
//   - chevron (expand/collapse)
//   - folder chip + name (clickable to toggle expansion)
//   - count badge (number of PDFs assigned to the folder — the
//     host owns the aggregation and passes the count in)
//   - kebab menu (rename / new subfolder / delete)
//
// All mutations are exposed via callback props so the host
// (`PdfFoldersSidebar`) can wire them to the CRUD layer and own
// any confirmations. The tree is purely presentational.

import { ReactNode, useCallback, useRef, useState } from "react";

import type { PdfFolderNode } from "@ff/data/hooks";
import PdfFolderChip from "./PdfFolderChip";
import Popover from "./Popover";

export interface FolderTreeProps {
  tree: PdfFolderNode[];
  /** folderId → PDF count for that folder (NOT recursive). */
  counts: Map<string, number>;
  /** IDs of folders currently expanded. The tree is controlled;
   *  the host owns the open-state map so it persists across
   *  re-renders and tab switches. */
  openIds: Set<string>;
  onToggle: (folderId: string) => void;
  onRequestRename: (folderId: string) => void;
  onRequestDelete: (folderId: string) => void;
  onRequestNewSubfolder: (parentId: string) => void;
  /** Per-folder content to render inside the open row, beneath
   *  the subfolders. Used by the host to nest the per-folder
   *  PDF list directly under its folder row (instead of
   *  rendering it as a sibling at the body level). The
   *  content is rendered only when the folder is open. */
  folderExtras?: Map<string, ReactNode>;
}

const rowStyle = (depth: number, isHovered: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 12px",
  paddingLeft: 12 + depth * 16,
  fontSize: 13,
  color: "var(--ff-text-primary)",
  background: isHovered ? "var(--ff-bg-hover)" : "transparent",
  cursor: "default",
  userSelect: "none",
  position: "relative",
});

const chevronStyle = (open: boolean, hasChildren: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  color: "var(--ff-text-muted)",
  transform: open ? "rotate(90deg)" : "rotate(0deg)",
  transition: "transform 150ms ease",
  flexShrink: 0,
  background: "transparent",
  border: "none",
  cursor: hasChildren ? "pointer" : "default",
  padding: 0,
  opacity: hasChildren ? 1 : 0.3,
});

const nameStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const countBadgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 22,
  height: 16,
  padding: "0 6px",
  borderRadius: 8,
  background: "var(--ff-badge-bg)",
  color: "var(--ff-text-muted)",
  fontSize: 11,
  fontWeight: 600,
  flexShrink: 0,
};

const kebabStyle = (visible: boolean): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 3,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--ff-text-muted)",
  visibility: visible ? "visible" : "hidden",
  flexShrink: 0,
  padding: 0,
});

function ChevronIcon(): ReactNode {
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
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function KebabIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function FolderRowMenu({
  anchor,
  onRename,
  onNewSubfolder,
  onDelete,
  onClose,
}: {
  anchor: HTMLElement | null;
  onRename: () => void;
  onNewSubfolder: () => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <Popover
      open
      anchor={anchor}
      placement="below-right"
      width={180}
      role="menu"
      onClose={onClose}
      data-testid="folder-tree-menu"
    >
      <MenuItem label="Rename" onClick={onRename} testId="folder-tree-menu-rename" />
      <MenuItem
        label="New subfolder"
        onClick={onNewSubfolder}
        testId="folder-tree-menu-new-subfolder"
      />
      <MenuItem
        label="Delete"
        onClick={onDelete}
        danger
        testId="folder-tree-menu-delete"
      />
    </Popover>
  );
}

function MenuItem({
  label,
  onClick,
  danger,
  testId,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  testId: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "6px 10px",
        fontSize: 13,
        color: danger ? "#dc2626" : "var(--ff-text-primary)",
        background: "transparent",
        border: "none",
        borderRadius: 3,
        cursor: "pointer",
      }}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

function FolderRow({
  node,
  count,
  open,
  openIds,
  counts,
  onToggle,
  onRequestRename,
  onRequestDelete,
  onRequestNewSubfolder,
  folderExtras,
}: {
  node: PdfFolderNode;
  count: number;
  open: boolean;
  openIds: Set<string>;
  counts: Map<string, number>;
  onToggle: (folderId: string) => void;
  onRequestRename: (folderId: string) => void;
  onRequestDelete: (folderId: string) => void;
  onRequestNewSubfolder: (parentId: string) => void;
  folderExtras?: Map<string, ReactNode>;
}): ReactNode {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabButtonRef = useRef<HTMLButtonElement | null>(null);

  const hasChildren = node.children.length > 0;
  const toggleOpen = useCallback(() => {
    onToggle(node.folder.id);
  }, [onToggle, node.folder.id]);

  return (
    <div
      data-testid="folder-tree-row"
      data-folder-id={node.folder.id}
      data-folder-depth={node.depth}
    >
      <div
        style={rowStyle(node.depth, hovered)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <button
          type="button"
          style={chevronStyle(open && hasChildren, hasChildren)}
          onClick={toggleOpen}
          aria-label={open ? "Collapse folder" : "Expand folder"}
          aria-expanded={open && hasChildren}
          data-testid="folder-tree-chevron"
        >
          {hasChildren ? <ChevronIcon /> : null}
        </button>
        <span style={{ display: "inline-flex", flexShrink: 0 }} aria-hidden>
          {/* Empty-name chip acts as a colored dot — the chip's
              own name is rendered to the right of it. Keeps the
              color signal without duplicating the name. */}
          <PdfFolderChip name="" color={node.folder.color} />
        </span>
        <span style={nameStyle} onClick={toggleOpen} title={node.folder.name}>
          {node.folder.name}
        </span>
        <span
          style={countBadgeStyle}
          title={`${count} PDF${count === 1 ? "" : "s"}`}
        >
          {count}
        </span>
        <button
          type="button"
          ref={kebabButtonRef}
          style={kebabStyle(hovered || menuOpen)}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label={`Folder actions for ${node.folder.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="folder-tree-kebab"
        >
          <KebabIcon />
        </button>
        {menuOpen ? (
          <FolderRowMenu
            anchor={kebabButtonRef.current}
            onRename={() => {
              setMenuOpen(false);
              onRequestRename(node.folder.id);
            }}
            onNewSubfolder={() => {
              setMenuOpen(false);
              onRequestNewSubfolder(node.folder.id);
            }}
            onDelete={() => {
              setMenuOpen(false);
              onRequestDelete(node.folder.id);
            }}
            onClose={() => setMenuOpen(false)}
          />
        ) : null}
      </div>
      {open
        ? node.children.map((child) => (
            <FolderRow
              key={child.folder.id}
              node={child}
              count={counts.get(child.folder.id) ?? 0}
              open={openIds.has(child.folder.id)}
              openIds={openIds}
              counts={counts}
              onToggle={onToggle}
              onRequestRename={onRequestRename}
              onRequestDelete={onRequestDelete}
              onRequestNewSubfolder={onRequestNewSubfolder}
              folderExtras={folderExtras}
            />
          ))
        : null}
      {open && folderExtras?.has(node.folder.id)
        ? folderExtras.get(node.folder.id)
        : null}
    </div>
  );
}

export default function FolderTree({
  tree,
  counts,
  openIds,
  onToggle,
  onRequestRename,
  onRequestDelete,
  onRequestNewSubfolder,
  folderExtras,
}: FolderTreeProps): ReactNode {
  if (tree.length === 0) {
    return (
      <div
        style={{
          padding: "16px",
          fontSize: 12,
          color: "var(--ff-text-muted)",
          lineHeight: 1.5,
        }}
        data-testid="folder-tree-empty"
      >
        No folders yet. Use the + button above to create one.
      </div>
    );
  }
  return (
    <div data-testid="folder-tree">
      {tree.map((node) => (
        <FolderRow
          key={node.folder.id}
          node={node}
          count={counts.get(node.folder.id) ?? 0}
          open={openIds.has(node.folder.id)}
          openIds={openIds}
          counts={counts}
          onToggle={onToggle}
          onRequestRename={onRequestRename}
          onRequestDelete={onRequestDelete}
          onRequestNewSubfolder={onRequestNewSubfolder}
          folderExtras={folderExtras}
        />
      ))}
    </div>
  );
}