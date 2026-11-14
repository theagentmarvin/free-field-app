// src/components/EmptyViewerDropzone.tsx
//
// Centered "Drop an IFC here" placeholder rendered when the active
// building has no IFCs. Includes a Browse button that opens the same
// file picker as the sidebar's <UploadButton>.
//
// The dropzone is "decorative" in that the actual file ingest is
// not implemented via drag-and-drop in Task 3 — only the Browse
// button is wired. (HTML5 drag-and-drop is feasible but stretches
// the scope; Phase 2 can add real drop semantics.)

import { ReactNode } from "react";

import UploadButton from "./UploadButton";

export interface EmptyViewerDropzoneProps {
  onFiles: (files: File[]) => void | Promise<void>;
  busy?: boolean;
}

const wrapperStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  color: "var(--ff-text-muted)",
  fontSize: 14,
  fontFamily: "var(--ff-font-stack)",
};

const textStyle: React.CSSProperties = {
  fontSize: 14,
  color: "var(--ff-text-muted)",
};

const dashedBoxStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: "32px 48px",
  border: "2px dashed var(--ff-border)",
  borderRadius: 8,
  background: "rgba(255, 255, 255, 0.6)",
};

export default function EmptyViewerDropzone({
  onFiles,
  busy = false,
}: EmptyViewerDropzoneProps): ReactNode {
  return (
    <div style={wrapperStyle} data-testid="empty-dropzone">
      <div style={dashedBoxStyle}>
        <div style={textStyle}>Drop an IFC here</div>
        <UploadButton
          onFiles={onFiles}
          busy={busy}
          variant="full"
          label="Browse…"
        />
      </div>
    </div>
  );
}
