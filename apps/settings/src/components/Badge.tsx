// src/components/Badge.tsx
//
// Small count badge used in the section group headers of the PDF
// placeholder block. Styled per docs/STYLING.md §8: 12px border-radius,
// 1px / 7px padding, --ff-badge-bg background, 11px font.

import { CSSProperties, memo } from "react";

export interface BadgeProps {
  count: number;
  className?: string;
}

const style: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minWidth: 18,
  borderRadius: "var(--ff-badge-radius)",
  padding: "var(--ff-badge-py) var(--ff-badge-px)",
  background: "var(--ff-badge-bg)",
  color: "var(--ff-text-primary)",
  fontSize: "var(--ff-badge-font-size)",
  fontWeight: 500,
  lineHeight: 1.4,
};

function Badge({ count, className }: BadgeProps) {
  return (
    <span
      className={className ?? "ff-badge"}
      style={style}
      aria-label={`${count} items`}
    >
      {count}
    </span>
  );
}

export default memo(Badge);
