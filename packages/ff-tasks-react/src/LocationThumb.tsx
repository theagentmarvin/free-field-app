import { useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";

import { usePhotoUrl, type PhotoUrlResolver } from "./usePhotoUrl";
import { isLinkviewLocation } from "@ff/tasks";

import { OPEN_LABEL, taskOpenKind, useOpenTaskLocation, type OpenableTask } from "./taskTarget";

/**
 * Location-snapshot thumb (Day-3). Same discipline as the list/table
 * photo thumbs: a Storage path resolved through the shared usePhotoUrl
 * cache — N surfaces pointing at one location cost ONE lookup, and a
 * failed/unresolved path renders NOTHING (the stylized placeholder
 * stands in), never a broken image.
 *
 * With `onOpen` the thumb is a quick-access control: hand cursor, a hover
 * ring and an "Open in Models / Documents" tooltip.
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
  onOpen,
  openLabel,
}: {
  path: string | null | undefined;
  resolve: PhotoUrlResolver | undefined;
  label: string;
  style?: CSSProperties;
  testId?: string;
  /** quick access: open the view this task was created in */
  onOpen?: () => void;
  /** tooltip / aria label for the quick-access action */
  openLabel?: string;
}): JSX.Element | null {
  const url = usePhotoUrl(resolve, path);
  const [hover, setHover] = useState(false);
  if (!url) return null;
  const img = (
    <img
      className="ff-location-thumb"
      data-testid={testId}
      src={url}
      alt={label}
      title={onOpen ? undefined : label}
      width={typeof style?.width === "number" ? style.width : 24}
      height={typeof style?.height === "number" ? style.height : 24}
      style={{ ...defaultStyle, ...style }}
    />
  );
  if (!onOpen) return img;
  const act = (e: MouseEvent | KeyboardEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    onOpen();
  };
  return (
    <span
      role="button"
      tabIndex={0}
      className="ff-location-thumb-link"
      data-testid={`${testId}-open`}
      aria-label={openLabel ?? "Open location"}
      title={openLabel ?? "Open location"}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") act(e);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        display: "inline-flex",
        flex: "0 0 auto",
        cursor: "pointer",
        borderRadius: 7,
        outline: hover ? "2px solid #2f6fe4" : "2px solid transparent",
        outlineOffset: 1,
        filter: hover ? "brightness(0.92)" : "none",
        transition: "outline-color 100ms ease, filter 100ms ease",
        verticalAlign: "middle",
      }}
    >
      {img}
    </span>
  );
}

/**
 * <LocationThumb> wired to the task's quick access: clicking opens the
 * view the task was created in (Models with the saved camera, or
 * Documents on the pinned sheet, or LinkView for a task created there).
 * A task with no openable location renders the plain thumb.
 *
 * LinkView dual location: when `path2d` is given AND the task was created
 * in LinkView (`location.origin === 'linkview'` with both sides), the plan
 * snapshot and the 3D snapshot render SIDE BY SIDE (plan left, 3D right),
 * each a quick-access control that opens LinkView. Every other task, or a
 * LinkView task missing a snapshot, renders the single thumb as before.
 */
export function OpenableLocationThumb({
  task,
  path,
  path2d,
  resolve,
  label,
  style,
  testId,
}: {
  task: OpenableTask;
  path: string | null | undefined;
  /** plan snapshot (`location.thumb2d`); only used for LinkView tasks */
  path2d?: string | null;
  resolve: PhotoUrlResolver | undefined;
  label: string;
  style?: CSSProperties;
  testId?: string;
}): JSX.Element | null {
  const open = useOpenTaskLocation();
  const kind = taskOpenKind(task);
  if (path && path2d && isLinkviewLocation(task.location)) {
    const base = testId ?? "ff-location-thumb";
    return (
      <span
        data-testid={`${base}-dual`}
        style={{ display: "inline-flex", alignItems: "center", gap: 3, flex: "0 0 auto", verticalAlign: "middle" }}
      >
        <LocationThumb
          path={path2d}
          resolve={resolve}
          label={`Plan snapshot: ${label}`}
          style={style}
          testId={`${base}-2d`}
          onOpen={() => open(task)}
          openLabel={OPEN_LABEL.linkview}
        />
        <LocationThumb
          path={path}
          resolve={resolve}
          label={`3D snapshot: ${label}`}
          style={style}
          testId={`${base}-3d`}
          onOpen={() => open(task)}
          openLabel={OPEN_LABEL.linkview}
        />
      </span>
    );
  }
  return (
    <LocationThumb
      path={path}
      resolve={resolve}
      label={label}
      style={style}
      testId={testId}
      onOpen={kind ? () => open(task) : undefined}
      openLabel={kind ? OPEN_LABEL[kind] : undefined}
    />
  );
}
