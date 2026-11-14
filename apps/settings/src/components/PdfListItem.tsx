// src/components/PdfListItem.tsx
//
// One row in the PDF list. Mirrors <IfcListItem>'s visual shape
// exactly: file icon + filename + <VersionPill> + kebab menu +
// decorative drag handle. The icon is the existing PdfIcon SVG
// (re-defined here — see "Notes on sharing" below).
//
// Click behavior (Task 11):
//   - onClick    → setActivePdfVersionId(latestVersionId).
//   - onDoubleClick → same (redundant path; cheap to wire).
// The PDF canvas in the right panel replaces the 3D viewer for
// the duration of the open. The parent also calls
// setActivePdfVersionId after a successful upload so the user
// lands in the canvas without an extra click (Maintainer's flow
// 2026-06-02: "user will see the pdf when he clicks the pdf" —
// uploading counts as activating).
//
// Notes on sharing: the PdfIcon was originally defined in
// PdfSidebarBlock.tsx. Rather than promote it to a public
// module (and risk over-engineering the surface), we duplicate
// the small SVG here. It's a 17-line, side-effect-free
// functional component — the duplication is bounded and the
// alternative (a shared icon file) is more code, not less.

import { ReactNode, useCallback, useState } from "react";

import type { PdfFileWithVersions } from "@hooks/usePdfFiles";

import VersionPill from "./VersionPill";
import IfcListItemMenu from "./IfcListItemMenu";

export interface PdfListItemProps {
  entry: PdfFileWithVersions;
  isReplacing: boolean;
  /** Click → set the active PDF version. Fired on row click
   *  and on row double-click (redundant — see spec). */
  onActivate: (versionId: string) => void;
  /** Kebab menu: replace version (opens file picker). */
  onRequestReplace: (pdfFileId: string) => void;
  /** Kebab menu: delete (cascade). */
  onRequestDelete: (entry: PdfFileWithVersions) => void;
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: "var(--ff-row-height)",
  padding: "0 var(--ff-row-px)",
  borderBottom: "1px solid var(--ff-divider)",
  background: "var(--ff-bg-app)",
  position: "relative",
  fontSize: 14,
  color: "var(--ff-text-primary)",
  cursor: "pointer",
};

const iconWrapStyle: React.CSSProperties = {
  width: 20,
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  color: "var(--ff-pdf-icon)",
};

const nameStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const kebabStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 3,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "var(--ff-drag-handle)",
  flexShrink: 0,
  padding: 0,
  transition: "color 150ms ease",
};

const dragHandleStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--ff-icon-drag-size)",
  height: "var(--ff-icon-drag-size)",
  color: "var(--ff-drag-handle)",
  flexShrink: 0,
  cursor: "grab",
  pointerEvents: "none",
};

function PdfIcon(): ReactNode {
  // Stylized PDF icon — a folded page with a small PDF label inside.
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="currentColor"
      aria-hidden
    >
      <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5Z" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontFamily="ui-sans-serif, system-ui"
        fontSize="6"
        fontWeight={700}
        fill="#ffffff"
      >
        PDF
      </text>
    </svg>
  );
}

function DragHandleIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </svg>
  );
}

function KebabIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

export default function PdfListItem({
  entry,
  isReplacing,
  onActivate,
  onRequestReplace,
  onRequestDelete,
}: PdfListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [hovered, setHovered] = useState(false);

  const openMenu = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      setAnchor(e.currentTarget.getBoundingClientRect());
      setMenuOpen((v) => !v);
    },
    [],
  );

  const handleActivate = useCallback(() => {
    if (isReplacing) return;
    const latest = entry.latestVersion;
    if (!latest) return;
    onActivate(latest.id);
  }, [isReplacing, onActivate, entry.latestVersion]);

  const latest = entry.latestVersion;
  const versionNumber = latest?.versionNumber ?? 0;

  return (
    <div
      className="ff-pdf-list-item"
      style={{
        ...rowStyle,
        ...(hovered && !isReplacing
          ? { background: "var(--ff-bg-hover)" }
          : null),
      }}
      data-testid="pdf-list-item"
      data-pdf-file-id={entry.file.id}
      data-active-pdf-version-id={latest?.id ?? ""}
      data-hover={hovered && !isReplacing ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleActivate}
      onDoubleClick={handleActivate}
    >
      <span style={iconWrapStyle} aria-hidden>
        <PdfIcon />
      </span>
      <span style={nameStyle} title={entry.file.name}>
        {entry.file.name}
      </span>
      {isReplacing ? (
        <span
          style={{
            fontSize: 11,
            color: "var(--ff-text-muted)",
            flexShrink: 0,
          }}
        >
          replacing…
        </span>
      ) : versionNumber > 0 ? (
        <VersionPill version={versionNumber} />
      ) : null}
      <button
        type="button"
        style={{
          ...kebabStyle,
          color: hovered ? "var(--ff-text-primary)" : "var(--ff-drag-handle)",
        }}
        onClick={openMenu}
        aria-label={`Open menu for ${entry.file.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={isReplacing}
        data-testid="pdf-list-item-kebab"
      >
        <KebabIcon />
      </button>
      <span style={dragHandleStyle} aria-hidden>
        <DragHandleIcon />
      </span>
      <IfcListItemMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onReplaceVersion={() => onRequestReplace(entry.file.id)}
        onDelete={() => onRequestDelete(entry)}
        anchorRect={anchor}
      />
    </div>
  );
}
