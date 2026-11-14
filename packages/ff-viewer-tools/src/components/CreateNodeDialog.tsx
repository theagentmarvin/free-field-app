// apps/models/src/components/CreateNodeDialog.tsx
//
// Modal dialog for entering a label when the user clicks the toolbar
// `+` folder or `+` filter button. Calls `onSubmit(label)` on confirm,
// `onCancel()` on dismiss. The caller (FiltersPanel) is responsible
// for actually creating the node — this component is presentational.

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

export type CreateNodeKind = "folder" | "filter";

export interface CreateNodeDialogProps {
  /** What kind of node we're creating — drives the title + button label. */
  kind: CreateNodeKind;
  /** Optional suggested name (rare; used by Duplicate flow later). */
  suggestedName?: string;
  onSubmit: (label: string) => void;
  onCancel: () => void;
}

export default function CreateNodeDialog({
  kind,
  suggestedName,
  onSubmit,
  onCancel,
}: CreateNodeDialogProps): JSX.Element {
  const [label, setLabel] = useState<string>(suggestedName ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount + close on Escape.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function commit(): void {
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
  }

  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0, 0, 0, 0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const cardStyle: CSSProperties = {
    background: "var(--ff-bg-elevated)",
    border: "1px solid var(--ff-border)",
    borderRadius: 8,
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.25)",
    padding: 18,
    width: 320,
    maxWidth: "90vw",
  };

  const titleStyle: CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--ff-text-primary)",
    marginBottom: 12,
  };

  const inputStyle: CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    fontSize: 13,
    border: "1px solid var(--ff-border)",
    borderRadius: 4,
    background: "var(--ff-bg-app)",
    color: "var(--ff-text-primary)",
    boxSizing: "border-box",
  };

  const buttonsStyle: CSSProperties = {
    display: "flex",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 14,
  };

  const buttonBase: CSSProperties = {
    padding: "6px 12px",
    fontSize: 12,
    borderRadius: 4,
    cursor: "pointer",
    border: "1px solid var(--ff-border)",
    background: "transparent",
    color: "var(--ff-text-primary)",
  };

  const primaryButton: CSSProperties = {
    ...buttonBase,
    background: "var(--ff-blue-active)",
    borderColor: "var(--ff-blue-active)",
    color: "white",
  };

  const title = kind === "folder" ? "New folder" : "New filter";
  const button = kind === "folder" ? "Create folder" : "Create filter";

  return (
    <div
      style={backdropStyle}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="create-node-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={titleStyle}>{title}</div>
        <input
          ref={inputRef}
          type="text"
          value={label}
          placeholder={kind === "folder" ? "Folder name" : "Filter name"}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          style={inputStyle}
          data-testid="create-node-dialog-input"
        />
        <div style={buttonsStyle}>
          <button
            type="button"
            onClick={onCancel}
            style={buttonBase}
            data-testid="create-node-dialog-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={label.trim().length === 0}
            style={{
              ...primaryButton,
              opacity: label.trim().length === 0 ? 0.5 : 1,
              cursor:
                label.trim().length === 0 ? "not-allowed" : "pointer",
            }}
            data-testid="create-node-dialog-submit"
          >
            {button}
          </button>
        </div>
      </div>
    </div>
  );
}
