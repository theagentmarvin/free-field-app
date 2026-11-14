import { useEffect, useRef, type CSSProperties } from "react";

import { tokens } from "./formStyles";

/**
 * Bottom-centre toast with an optional action (Undo). `role="status"`
 * so assistive tech announces it; auto-dismisses after `ms` (paused
 * while hovered/focused so the Undo button can always be reached).
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export interface TaskToastProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
  ms?: number;
  /** sit above the sticky bulk-selection bar */
  lift?: boolean;
}

const toastStyle: CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: s.s6,
  transform: "translateX(-50%)",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: s.s3,
  maxWidth: "min(92vw, 520px)",
  padding: `${s.s2 + 2}px ${s.s4}px`,
  borderRadius: r.md,
  background: c.primary,
  color: c.onPrimary,
  fontSize: f.md,
  fontFamily: tokens.font,
  boxShadow: tokens.shadow.raised,
};

export function TaskToast({ message, actionLabel, onAction, onDismiss, ms = 8000, lift = false }: TaskToastProps): JSX.Element {
  const hold = useRef(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const arm = () => {
      t = setTimeout(() => {
        if (hold.current) arm();
        else dismiss.current();
      }, ms);
    };
    arm();
    return () => clearTimeout(t);
  }, [message, ms]);
  return (
    <div
      role="status"
      aria-live="polite"
      className="ff-task-toast"
      data-testid="task-toast"
      style={lift ? { ...toastStyle, bottom: 120 } : toastStyle}
      onMouseEnter={() => (hold.current = true)}
      onMouseLeave={() => (hold.current = false)}
      onFocus={() => (hold.current = true)}
      onBlur={() => (hold.current = false)}
    >
      <span style={{ flex: "1 1 auto" }}>{message}</span>
      {actionLabel && onAction && (
        <button
          type="button"
          data-testid="task-toast-action"
          onClick={onAction}
          style={{ border: "none", background: "transparent", color: "#9db8ff", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", fontSize: f.md, padding: "2px 4px" }}
        >
          {actionLabel}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        style={{ border: "none", background: "transparent", color: c.muted, cursor: "pointer", fontSize: f.base, padding: "2px 4px" }}
      >
        ✕
      </button>
    </div>
  );
}
