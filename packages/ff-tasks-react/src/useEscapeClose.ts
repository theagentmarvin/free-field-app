import { useEffect, useRef } from "react";

/**
 * Close a sheet on Escape. Bubble-phase on `window`, so a nested layer
 * (lightbox, activity popup, anchored popover) that handles Escape first
 * and calls `stopPropagation()` keeps the sheet beneath it open — one
 * Escape closes exactly one layer.
 */
export function useEscapeClose(onClose: () => void): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" && !e.defaultPrevented) ref.current();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
