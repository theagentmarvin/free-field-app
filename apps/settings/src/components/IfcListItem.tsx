// src/components/IfcListItem.tsx
//
// One row in the IFC list. Shows the purple cube icon, filename,
// <VersionPill>, kebab menu, and a decorative drag handle. Kebab is
// muted by default and full-color on row hover per the spec.
//
// All file-handling side effects (replace / delete) are routed
// through the parent — this component is a pure render of the row
// plus the kebab menu trigger. The drag handle is non-functional
// for Task 3 (see docs/TASK-3-UI.md "Out of scope").
//
// Task 11 (PDF Canvas) addendum: an `onClick` handler is now wired
// into the row so clicking an IFC row returns the right panel to
// the 3D viewer (clears `activePdfVersionId`). The click does NOT
// open a level view — that's the click-to-open path on the Mapped
// section. This is just the "swap back from PDF canvas to 3D"
// gesture described in docs/TASK-11-PDF-CANVAS.md "Click behavior".

import { ReactNode, useCallback, useState } from "react";

import type { IfcFileWithVersions } from "@ff/data/hooks";

import IfcListItemMenu from "./IfcListItemMenu";
import VersionPill from "./VersionPill";

export interface IfcListItemProps {
  entry: IfcFileWithVersions;
  isReplacing: boolean;
  onRequestReplace: (fileId: string) => void;
  onRequestDelete: (entry: IfcFileWithVersions) => void;
  /**
   * Fired when the user clicks anywhere on the row that isn't
   * the kebab menu or another button. Task 11: the parent uses
   * this to clear `activePdfVersionId` so the right panel swaps
   * back from the PDF canvas to the 3D viewer. Optional — older
   * call sites (e.g. unit tests) can omit it.
   */
  onClick?: (entry: IfcFileWithVersions) => void;
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
  color: "var(--ff-ifc-icon)",
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
  color: "var(--ff-drag-handle)", // muted by default
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
  // The handle is decorative — `pointer-events: none` lets the
  // click pass through to the row, so future "click-to-select" UX
  // isn't blocked by an invisible overlay.
  pointerEvents: "none",
};

function CubeIcon(): ReactNode {
  // Inline isometric-ish cube glyph. Matches the "purple cube" mockup
  // description; lucide-react has a `box` icon that would also work
  // but we keep the dep graph small here.
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="currentColor"
      aria-hidden
    >
      <path
        d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.4 3.5L12 11.3 5.6 7.8 12 4.3ZM5 9.4l6 3.3v7.4l-6-3.3V9.4Zm14 0v7.4l-6 3.3v-7.4l6-3.3Z"
        opacity={0.95}
      />
    </svg>
  );
}

function DragHandleIcon(): ReactNode {
  // Six-dot grip glyph — looks like the standard "drag handle" icon.
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

export default function IfcListItem({
  entry,
  isReplacing,
  onRequestReplace,
  onRequestDelete,
  onClick,
}: IfcListItemProps) {
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

  const handleRowClick = useCallback(() => {
    if (isReplacing) return;
    onClick?.(entry);
  }, [isReplacing, onClick, entry]);

  const latest = entry.latestVersion;
  const versionNumber = latest?.versionNumber ?? 0;

  return (
    <div
      className="ff-ifc-list-item"
      style={{
        ...rowStyle,
        ...(hovered && !isReplacing
          ? { background: "var(--ff-bg-hover)" }
          : null),
      }}
      data-testid="ifc-list-item"
      data-ifc-file-id={entry.file.id}
      data-hover={hovered && !isReplacing ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={handleRowClick}
    >
      <span style={iconWrapStyle} aria-hidden>
        <CubeIcon />
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
        data-testid="ifc-list-item-kebab"
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
