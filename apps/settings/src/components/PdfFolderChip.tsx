// src/components/PdfFolderChip.tsx
//
// Small pill that displays a PDF folder: a tiny folder icon, the
// folder name, and a colored background keyed by the folder's
// stored `color` field. Used in two places:
//   1. inline next to PDF rows in the Folders sub-tab's per-folder
//      list (so the user sees the row's folder origin)
//   2. inside the FolderTree's row UI for the root / nested folder
//      rows (so the tree can be visually scanned by color)
//
// The chip is read-only by design: clicking it does NOT activate
// the folder. Activation is the FolderTree row's responsibility.
// If a future task wires click-to-open, lift `onClick` here.

import { CSSProperties, ReactNode, memo } from "react";

export interface PdfFolderChipProps {
  name: string;
  /** One of the fixed palette in `pdfFolders.ts` PDF_FOLDER_COLORS. */
  color: string;
  className?: string;
  title?: string;
}

const baseStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  borderRadius: "var(--ff-folder-radius)",
  padding: "var(--ff-folder-py) var(--ff-folder-px)",
  fontSize: "var(--ff-folder-font-size)",
  fontWeight: "var(--ff-folder-font-weight)",
  letterSpacing: "var(--ff-tag-letter-spacing)",
  lineHeight: 1.2,
  whiteSpace: "nowrap",
  maxWidth: "100%",
  minWidth: 0,
};

/** Per-color recipe. Unknown colors fall back to slate so a typo
 *  in a folder row doesn't render with no background. */
const colorStyle = (color: string): CSSProperties => {
  switch (color) {
    case "blue":
      return {
        background: "var(--ff-folder-blue-bg)",
        color: "var(--ff-folder-blue-text)",
      };
    case "green":
      return {
        background: "var(--ff-folder-green-bg)",
        color: "var(--ff-folder-green-text)",
      };
    case "amber":
      return {
        background: "var(--ff-folder-amber-bg)",
        color: "var(--ff-folder-amber-text)",
      };
    case "rose":
      return {
        background: "var(--ff-folder-rose-bg)",
        color: "var(--ff-folder-rose-text)",
      };
    case "violet":
      return {
        background: "var(--ff-folder-violet-bg)",
        color: "var(--ff-folder-violet-text)",
      };
    case "slate":
    default:
      return {
        background: "var(--ff-folder-slate-bg)",
        color: "var(--ff-folder-slate-text)",
      };
  }
};

function FolderIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

function PdfFolderChip({
  name,
  color,
  className,
  title,
}: PdfFolderChipProps): ReactNode {
  return (
    <span
      className={className ?? `ff-folder-chip ff-folder-chip--${color}`}
      style={{ ...baseStyle, ...colorStyle(color) }}
      title={title ?? name}
      data-testid="pdf-folder-chip"
      data-folder-color={color}
    >
      <FolderIcon />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
    </span>
  );
}

export default memo(PdfFolderChip);