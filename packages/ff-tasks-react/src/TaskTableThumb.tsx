import type { CSSProperties } from "react";

import { usePhotoUrl, type PhotoUrlResolver } from "./usePhotoUrl";

/**
 * Table-row photo thumb (Wave 5A, VDC 2026-11-02). Mirrors the list
 * row's 24px thumb but owned by the table so `tableColumns.ts` can
 * construct it as a structural render descriptor (no Firebase — the
 * resolver is passed in via the render ctx, and `usePhotoUrl` keeps
 * N rows on one photo down to ONE lookup). A failed/unresolved photo
 * renders NOTHING — no broken image, no error, no layout shift.
 */

const thumbStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  objectFit: "cover",
  flex: "0 0 auto",
  background: "#f1f3f4",
  border: "1px solid #e4e6e7",
  verticalAlign: "middle",
  marginRight: 6,
};

export function TaskTableThumb({
  path,
  resolve,
  label,
}: {
  path: string | undefined;
  resolve: PhotoUrlResolver | undefined;
  label: string;
}): JSX.Element | null {
  const url = usePhotoUrl(resolve, path);
  if (!url) return null;
  return (
    <img
      className="ff-task-table-thumb"
      data-testid="ff-task-table-thumb"
      src={url}
      alt={label}
      title={label}
      width={24}
      height={24}
      style={thumbStyle}
    />
  );
}