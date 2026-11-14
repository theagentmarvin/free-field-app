// src/components/ConfirmDialog.tsx
//
// Reusable confirm modal used by building-delete and IFC-delete flows.
// Styled per docs/TASK-3-UI.md "Component breakdown":
//   - Centered, 1px border, white bg, max-width 400px
//   - Esc / Cancel / Confirm dismissal
//   - Reusable across flows
//
// We use a minimal modal layout (no portal, no focus trap library) so
// the file inventory stays small for Task 3. Esc dismiss is wired via
// document-level keydown while the dialog is open.

import { ReactNode, useCallback, useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 17, 21, 0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: "var(--ff-z-modal)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
  maxWidth: 400,
  width: "calc(100% - 32px)",
  padding: 20,
  fontFamily: "var(--ff-font-stack)",
  color: "var(--ff-text-primary)",
  boxShadow: "0 10px 25px rgba(0, 0, 0, 0.12)",
};

const titleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
};

const messageStyle: React.CSSProperties = {
  margin: "12px 0 20px",
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--ff-text-primary)",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
};

const baseButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 500,
  borderRadius: 4,
  // Non-shorthand borders. The `border: "1px solid ..."` shorthand was
  // spread into `dangerButtonStyle`; the danger variant then overrode
  // `borderColor` (longhand) on top, which is the same latent React 19
  // shorthand/longhand conflict shape. Currently benign because
  // `danger` is a prop that doesn't change within a dialog session,
  // but normalise to all-longhand to make the pattern grep-detectable.
  borderTop: "1px solid var(--ff-border)",
  borderRight: "1px solid var(--ff-border)",
  borderBottom: "1px solid var(--ff-border)",
  borderLeft: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: "pointer",
};

const dangerButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: "#dc2626",
  // Override all four border sides with the danger color.
  borderTopColor: "#dc2626",
  borderRightColor: "#dc2626",
  borderBottomColor: "#dc2626",
  borderLeftColor: "#dc2626",
  color: "#ffffff",
};

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Auto-focus the confirm button on open so Enter submits even from
  // a stale focused element. We don't bother with a full focus trap
  // for Task 3; the modal is the only interactive surface while open.
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
  }, [open]);

  // Esc dismisses. Bound to a capture-phase keydown so it fires even
  // when focus is on a child of the panel.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onCancel]);

  const handleConfirm = useCallback(() => {
    void onConfirm();
  }, [onConfirm]);

  if (!open) return null;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => {
        // Click on the dimmer (but not the panel) dismisses.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={panelStyle}>
        <h2 style={titleStyle}>{title}</h2>
        <div style={messageStyle}>{message}</div>
        <div style={actionsStyle}>
          <button
            type="button"
            style={baseButtonStyle}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            style={danger ? dangerButtonStyle : baseButtonStyle}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
