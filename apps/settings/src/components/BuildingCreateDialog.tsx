// src/components/BuildingCreateDialog.tsx
//
// Modal dialog for creating a new building. Used by the `+` tab in
// <BuildingTabs>. Reuses the same overlay / panel structure as
// <ConfirmDialog> but with an input field for the building name.
//
// Esc / Cancel dismiss; Enter submits if the name is non-empty.

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

export interface BuildingCreateDialogProps {
  open: boolean;
  onCreate: (name: string) => Promise<void> | void;
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

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 12,
  padding: "8px 10px",
  fontSize: 14,
  border: "1px solid var(--ff-border)",
  borderRadius: 4,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 20,
};

const baseButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 500,
  borderRadius: 4,
  // Non-shorthand borders — same fix as ConfirmDialog. The `border: "1px solid ..."`
  // shorthand + `borderColor` longhand override in the primary variant
  // is a latent React 19 shorthand/longhand conflict.
  borderTop: "1px solid var(--ff-border)",
  borderRight: "1px solid var(--ff-border)",
  borderBottom: "1px solid var(--ff-border)",
  borderLeft: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: "var(--ff-blue-active)",
  borderTopColor: "var(--ff-blue-active)",
  borderRightColor: "var(--ff-blue-active)",
  borderBottomColor: "var(--ff-blue-active)",
  borderLeftColor: "var(--ff-blue-active)",
  color: "#ffffff",
};

export default function BuildingCreateDialog({
  open,
  onCreate,
  onCancel,
}: BuildingCreateDialogProps) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset transient state every time the dialog opens. The "open"
  // transition is the natural reset point.
  useEffect(() => {
    if (open) {
      setName("");
      setBusy(false);
      // Defer to the next tick so the input is mounted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Esc dismisses (only if not busy — a pending submit shouldn't be
  // abandonable mid-flight).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, busy, onCancel]);

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      if (e) e.preventDefault();
      const trimmed = name.trim();
      if (trimmed.length === 0 || busy) return;
      setBusy(true);
      try {
        await onCreate(trimmed);
        // Successful create closes the dialog (parent flips `open`).
      } catch {
        // Parent surfaces the error via its own error UI; we just
        // unblock the input.
        setBusy(false);
      }
    },
    [name, busy, onCreate],
  );

  if (!open) return null;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Create building"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form style={panelStyle} onSubmit={handleSubmit}>
        <h2 style={titleStyle}>Create building</h2>
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Building name"
          maxLength={120}
          aria-label="Building name"
          style={inputStyle}
          disabled={busy}
        />
        <div style={actionsStyle}>
          <button
            type="button"
            style={baseButtonStyle}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            style={primaryButtonStyle}
            disabled={busy || name.trim().length === 0}
          >
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}
