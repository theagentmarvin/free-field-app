// src/components/IfcListItemMenu.tsx
//
// Kebab menu anchored to each <IfcListItem>. Two options:
//   - Replace version: triggers the file picker via the parent
//   - Delete: opens the <ConfirmDialog> via the parent
//
// Same outside-click / Esc dismissal pattern as <BuildingTabMenu>.

import { useCallback, useEffect, useRef } from "react";

export interface IfcListItemMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReplaceVersion: () => void;
  onDelete: () => void;
  anchorRect: DOMRect | null;
}

const menuStyle = (top: number, left: number): React.CSSProperties => ({
  position: "fixed",
  top,
  left,
  minWidth: 160,
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

export default function IfcListItemMenu({
  open,
  onOpenChange,
  onReplaceVersion,
  onDelete,
  anchorRect,
}: IfcListItemMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

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

  const handleReplace = useCallback(() => {
    onReplaceVersion();
    onOpenChange(false);
  }, [onReplaceVersion, onOpenChange]);

  const handleDelete = useCallback(() => {
    onDelete();
    onOpenChange(false);
  }, [onDelete, onOpenChange]);

  if (!open || !anchorRect) return null;

  const MENU_WIDTH = 160;
  const MENU_HEIGHT = 84;
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
        onClick={handleReplace}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.background =
            "var(--ff-bg-hover)";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.background = "transparent";
        }}
      >
        Replace version
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
