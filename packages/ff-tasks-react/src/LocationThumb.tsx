import type { CSSProperties } from "react";

import { usePhotoUrl, type PhotoUrlResolver } from "./usePhotoUrl";

/**
 * Location-snapshot thumb (Day-3). Same discipline as the list/table
 * photo thumbs: a Storage path resolved through the shared usePhotoUrl
 * cache — N surfaces pointing at one location cost ONE lookup, and a
 * failed/unresolved path renders NOTHING (the stylized placeholder
 * stands in), never a broken image.
 */

const defaultStyle: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  objectFit: "cover",
  flex: "0 0 auto",
  background: "#f1f3f4",
  border: "1px solid #e4e6e7",
};

export function LocationThumb({
  path,
  resolve,
  label,
  style,
  testId = "ff-location-thumb",
}: {
  path: string | null | undefined;
  resolve: PhotoUrlResolver | undefined;
  label: string;
  style?: CSSProperties;
  testId?: string;
}): JSX.Element | null {
  const url = usePhotoUrl(resolve, path);
  if (!url) return null;
  return (
    <img
      className="ff-location-thumb"
      data-testid={testId}
      src={url}
      alt={label}
      title={label}
      width={typeof style?.width === "number" ? style.width : 24}
      height={typeof style?.height === "number" ? style.height : 24}
      style={{ ...defaultStyle, ...style }}
    />
  );
}