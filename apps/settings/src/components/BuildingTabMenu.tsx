// src/components/BuildingTabMenu.tsx
//
// Kebab menu (⋯) anchored to each building tab. Two options:
//   - Rename: switches the parent <BuildingTab> to inline edit mode
//   - Delete: asks the parent to open the <ConfirmDialog>
//
// Anchored absolutely to the kebab icon. Closes on outside click /
// Esc. Styling is inline CSS using the same tokens as the rest of
// the UI; we don't pull in a menu library for Task 3.

import { useCallback, useEffect, useRef } from "react";

export interface BuildingTabMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
  /** The kebab button's own DOM rect — used to anchor the menu. */
  anchorRect: DOMRect | null;
  /** Whether the building is the active one (some actions might be disabled; for now we just style). */
  isActive?: boolean;
}

const menuStyle = (top: number, left: number): React.CSSProperties => ({
  position: "fixed",
  top,
  left,
  minWidth: 140,
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  borderRadius: 4,
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.1)",
  padding: 4,
  zIndex: "var(--ff-z-popover)",
  fontFamily: "var(--ff-font-stack)",
  fontSize: 14,
  color: "var(--ff-text-primary)",
});

const itemStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 12px",
  borderRadius: 3,
  background: "transparent",
  border: "none",
  cursor: "pointer",
  color: "inherit",
  fontSize: "inherit",
  fontFamily: "inherit",
};

const dangerItemStyle: React.CSSProperties = {
  ...itemStyle,
  color: "#dc2626",
};

export default function BuildingTabMenu({
  open,
  onOpenChange,
  onRename,
  onDelete,
  anchorRect,
  isActive: _isActive = false,
}: BuildingTabMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Outside-click / Esc dismissal. Bound while the menu is open.
  useEffect(() => {
    if (!open) return;
    const handleDocDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onOpenChange(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handleDocDown);
    document.addEventListener("keydown", handleKey, true);
    return () => {
      document.removeEventListener("mousedown", handleDocDown);
      document.removeEventListener("keydown", handleKey, true);
    };
  }, [open, onOpenChange]);

  const handleRename = useCallback(() => {
    onRename();
    onOpenChange(false);
  }, [onRename, onOpenChange]);

  const handleDelete = useCallback(() => {
    onDelete();
    onOpenChange(false);
  }, [onDelete, onOpenChange]);

  if (!open || !anchorRect) return null;

  // Anchor the menu below and to the right of the kebab; if the
  // anchor is near the right edge of the viewport, flip it to the
  // left so the menu doesn't overflow.
  const MENU_WIDTH = 140;
  const MENU_HEIGHT = 84; // ~approximate, 2 items
  const padding = 4;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 0;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 0;
  let top = anchorRect.bottom + padding;
  let left = anchorRect.left;
  if (left + MENU_WIDTH > viewportWidth) {
    left = Math.max(0, anchorRect.right - MENU_WIDTH);
  }
  if (top + MENU_HEIGHT > viewportHeight) {
    top = Math.max(0, anchorRect.top - MENU_HEIGHT - padding);
  }

  return (
    <div ref={menuRef} style={menuStyle(top, left)} role="menu">
      <button
        type="button"
        role="menuitem"
        style={itemStyle}
        onClick={handleRename}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background =
            "var(--ff-bg-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        style={dangerItemStyle}
        onClick={handleDelete}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background =
            "var(--ff-bg-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        Delete
      </button>
    </div>
  );
}
