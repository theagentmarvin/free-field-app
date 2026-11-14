import { useEffect, useRef, type CSSProperties } from "react";

import { buttonGhostStyle, tokens } from "./formStyles";

/**
 * Small modal confirm (delete / bulk discontinue / terminal board drop).
 * Escape cancels this layer ONLY (stopPropagation) so a sheet beneath
 * stays open; focus lands on Cancel so Enter never destroys by accident.
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export interface TaskConfirmDialogProps {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const scrim: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 70,
  background: c.scrim,
  display: "grid",
  placeItems: "center",
  padding: s.s4,
};

export function TaskConfirmDialog({ title, body, confirmLabel, danger = false, onConfirm, onCancel }: TaskConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  return (
    <div style={scrim} data-testid="task-confirm-scrim" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        data-testid="task-confirm"
        style={{ width: 380, maxWidth: "100%", background: c.surface, borderRadius: r.lg, boxShadow: tokens.shadow.raised, padding: s.s5, fontFamily: tokens.font, color: c.text }}
      >
        <h3 style={{ margin: 0, fontSize: f.lg }}>{title}</h3>
        {body && <p style={{ margin: `${s.s2}px 0 0`, fontSize: f.md, color: c.text2, lineHeight: 1.5 }}>{body}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: s.s2, marginTop: s.s5 }}>
          <button type="button" ref={cancelRef} onClick={onCancel} style={{ ...buttonGhostStyle, padding: "8px 14px" }}>
            Cancel
          </button>
          <button
            type="button"
            data-testid="task-confirm-ok"
            onClick={onConfirm}
            style={{ border: "none", borderRadius: r.md, padding: "8px 14px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: f.md, background: danger ? c.danger : c.primary, color: c.onPrimary }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
