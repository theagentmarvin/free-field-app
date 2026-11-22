import { useEffect } from "react";

import { setTaskOpenNotice, useTaskOpenState } from "./taskOpenStore";

/**
 * Global notice for quick-access opens ("the plan no longer exists",
 * "pinned on v1, showing v2"). Mounted once by the shell; auto-dismisses.
 */
export function TaskOpenNotice(): JSX.Element | null {
  const { notice } = useTaskOpenState();
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setTaskOpenNotice(null), 12000);
    return () => clearTimeout(t);
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="task-open-notice"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 72,
        transform: "translateX(-50%)",
        zIndex: 400,
        maxWidth: "min(560px, calc(100vw - 32px))",
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 14px",
        borderRadius: 12,
        background: "#1b1f24",
        color: "#fff",
        fontSize: 13,
        fontFamily: "inherit",
        boxShadow: "0 8px 24px rgba(16,24,40,0.28)",
      }}
    >
      <span style={{ flex: 1 }}>{notice}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setTaskOpenNotice(null)}
        style={{ border: "none", background: "transparent", color: "#cbd2da", cursor: "pointer", fontSize: 14 }}
      >
        ✕
      </button>
    </div>
  );
}
