// apps/documents/src/DocumentsPanelBody.tsx
//
// Wave 39 — the `docs` tenant body of the ONE floating Documents
// panel slot.
//
// This is the file/folder list formerly rendered by DocumentsSidebar
// (which is retired): folder groups + Unfiled pseudo-folder + PDF
// rows, minus the "Documents" header and minus the per-building
// <BuildingPicker> (the rail's combined switcher now owns the building
// dimension through the shared modelsToolStore.activeBuildingId).
//
// Folders are the primary navigation axis; each folder shows its PDFs.
// No search field / RECENT·ALL chips exist in this build (the spec
// described them, but they were never implemented in DocumentsSidebar
// — adapted, see wave-39 completion summary).

import {
  useCallback,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useModelsToolStore } from "../../../packages/ff-viewer-tools/src/modelsToolStore";

import {
  useDocumentsGroups,
  type FolderTreeNode,
  type PdfEntryWithFolder,
} from "./hooks/useDocumentsGroups";

export interface DocumentsPanelBodyProps {
  /** Currently active PDF version id, or null when nothing is selected. */
  activePdfVersionId: string | null;
  /** Fired when the user clicks a PDF row. */
  onActivate: (versionId: string) => void;
}

export default function DocumentsPanelBody({
  activePdfVersionId,
  onActivate,
}: DocumentsPanelBodyProps): ReactNode {
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const groups = useDocumentsGroups(activeBuildingId);

  return (
    <div data-testid="documents-panel-body">
      {groups === undefined || groups.tree.length === 0 ? (
        <div style={emptyStyle} data-testid="documents-panel-empty">
          No documents yet. Upload PDFs from the Settings module to
          see them here.
        </div>
      ) : (
        groups.tree.map((node) => (
          <FolderSection
            key={folderNodeKey(node)}
            node={node}
            activePdfVersionId={activePdfVersionId}
            onActivate={onActivate}
            isRoot
          />
        ))
      )}
    </div>
  );
}

/** Stable key for a FolderTreeNode. Folders have an id; the
 *  synthetic Unfiled pseudo-folder uses "__unfiled__". */
function folderNodeKey(node: FolderTreeNode): string {
  return node.folder?.id ?? "__unfiled__";
}

interface FolderSectionProps {
  node: FolderTreeNode;
  activePdfVersionId: string | null;
  onActivate: (versionId: string) => void;
  /** True for the outermost section (renders the folder chevron
   *  + count). Nested sub-folders render the same shape but
   *  with `depth`-based indentation. */
  isRoot: boolean;
}

function FolderSection({
  node,
  activePdfVersionId,
  onActivate,
  isRoot,
}: FolderSectionProps): ReactNode {
  const key = folderNodeKey(node);
  // Default open: open until the user collapses. The root
  // pseudo-section (Unfiled) opens by default; folders open
  // when they contain PDFs OR have child folders.
  const [userControlled, setUserControlled] = useState(false);
  const [userOpen, setUserOpen] = useState(true);
  const defaultOpen =
    node.folder === null || node.group === null
      ? true
      : node.group.rows.length > 0 || node.children.length > 0;
  const isOpen = userControlled ? userOpen : defaultOpen;

  const handleToggle = useCallback(() => {
    setUserControlled(true);
    setUserOpen((v) => !v);
  }, []);

  const label = node.folder?.name ?? "Unfiled";
  const count = node.group?.rows.length ?? 0;
  const isUnfiled = node.folder === null;

  return (
    <section
      style={sectionStyle}
      data-testid={`documents-folder-${key}`}
      data-folder-id={key}
      data-folder-depth={node.depth}
    >
      <div
        style={{
          ...folderHeaderStyle(node.depth, isRoot),
          background: "var(--ff-bg-app)",
        }}
        role="button"
        tabIndex={0}
        aria-expanded={isOpen}
        aria-controls={`documents-folder-body-${key}`}
        onClick={handleToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            handleToggle();
          }
        }}
        data-testid={`documents-folder-header-${key}`}
      >
        <span
          style={{
            ...chevronStyle,
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
          }}
          aria-hidden
        >
          <ChevronIcon />
        </span>
        <span
          style={{
            ...folderNameStyle,
            color: isUnfiled ? "var(--ff-text-muted)" : "var(--ff-text-primary)",
            fontStyle: isUnfiled ? "italic" : "normal",
          }}
        >
          {label}
        </span>
        <span style={folderCountStyle}>
          {count > 0 ? count : ""}
        </span>
      </div>
      {isOpen ? (
        <div
          id={`documents-folder-body-${key}`}
          style={folderBodyStyle}
          data-testid={`documents-folder-body-${key}`}
        >
          {node.group && node.group.rows.length === 0 ? (
            <div
              style={{
                ...emptyStyle,
                paddingLeft: 24 + node.depth * 12,
              }}
              data-testid={`documents-folder-empty-${key}`}
            >
              No PDFs in this folder.
            </div>
          ) : node.group ? (
            <ul
              style={listStyle}
              data-testid={`documents-folder-pdfs-${folderNodeKey(node)}`}
            >
              {node.group.rows.map((row) => (
                <PdfRow
                  key={row.file.id}
                  row={row}
                  isActive={activePdfVersionId === row.latestVersionId}
                  onActivate={onActivate}
                />
              ))}
            </ul>
          ) : null}
          {node.children.map((child) => (
            <FolderSection
              key={folderNodeKey(child)}
              node={child}
              activePdfVersionId={activePdfVersionId}
              onActivate={onActivate}
              isRoot={false}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

interface PdfRowProps {
  row: PdfEntryWithFolder;
  isActive: boolean;
  onActivate: (versionId: string) => void;
}

function PdfRow({ row, isActive, onActivate }: PdfRowProps): ReactNode {
  const handleClick = () => {
    if (row.latestVersionId) onActivate(row.latestVersionId);
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <li
      role="button"
      tabIndex={0}
      data-testid={`documents-sidebar-row-${row.file.id}`}
      aria-current={isActive ? "true" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      style={{
        ...rowStyle,
        background: isActive ? "var(--ff-bg-hover)" : "var(--ff-bg-app)",
        borderLeft: isActive
          ? "3px solid var(--ff-blue-active)"
          : "3px solid transparent",
      }}
    >
      <PdfIcon />
      <span style={filenameStyle}>{row.file.name}</span>
      {row.versionCount > 1 ? (
        <span style={versionPillStyle} aria-label={`${row.versionCount} versions`}>
          v{row.latestVersion?.versionNumber ?? "?"}/{row.versionCount}
        </span>
      ) : null}
    </li>
  );
}

/** Inline SVG PDF icon — same shape settings' PdfListItem uses. */
function PdfIcon(): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--ff-pdf-icon)" }}
    >
      <path
        d="M4 2.5h8l4 4v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M12 2.5v4h4" stroke="currentColor" strokeWidth="1.4" />
      <text
        x="10"
        y="14"
        textAnchor="middle"
        fontSize="5"
        fontWeight="700"
        fill="currentColor"
      >
        PDF
      </text>
    </svg>
  );
}

function ChevronIcon(): ReactNode {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3.5 1.5L7 5L3.5 8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Styles (inline; same CSS tokens as apps/models/) ─────────────────

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const folderHeaderStyle = (depth: number, isRoot: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: isRoot ? "10px 12px 6px" : "8px 12px 4px",
  paddingLeft: isRoot ? 12 : 12 + depth * 12,
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
  color: "var(--ff-text-muted)",
  cursor: "pointer",
  outline: "none",
  userSelect: "none",
});

const chevronStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 12,
  height: 12,
  color: "var(--ff-text-muted)",
  transition: "transform 150ms ease",
  flexShrink: 0,
};

const folderNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const folderCountStyle: CSSProperties = {
  fontWeight: 400,
  color: "var(--ff-text-muted)",
  fontSize: 11,
  textTransform: "none",
  letterSpacing: 0,
  flexShrink: 0,
};

const folderBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: "var(--ff-row-height)",
  padding: "0 13px",
  borderBottom: "1px solid var(--ff-divider)",
  cursor: "pointer",
  outline: "none",
  transition: "background 100ms ease",
};

const filenameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  color: "var(--ff-text-primary)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const versionPillStyle: CSSProperties = {
  flexShrink: 0,
  padding: "2px 7px",
  borderRadius: "var(--ff-badge-radius)",
  background: "var(--ff-badge-bg)",
  color: "var(--ff-text-primary)",
  fontSize: "var(--ff-badge-font-size)",
  fontWeight: 500,
};

const emptyStyle: CSSProperties = {
  padding: "16px",
  fontSize: 13,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};