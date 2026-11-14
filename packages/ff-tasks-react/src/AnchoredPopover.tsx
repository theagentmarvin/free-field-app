import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/**
 * Shared anchored popover for the tasks module. Renders through a portal at
 * `document.body` so no ancestor `overflow` (toolbar scroll row, table wrap)
 * can clip it, positions itself with `position: fixed` against the anchor's
 * viewport rect, flips above when there is more room there, clamps to the
 * viewport, caps its height to the available space (internal scroll), and
 * re-measures on resize and on scroll of ANY ancestor (capture listener).
 * Outside pointer-down and Escape close it; Escape returns focus to the anchor.
 *
 * (apps/settings has a similar `Popover`, but a package cannot import from an
 * app, so this is the tasks-module copy with max-height + scroll tracking.)
 */
export interface AnchoredPopoverProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Horizontal alignment of the popover to the anchor. Default "end" (right edges align). */
  align?: "start" | "end";
  /** Gap between anchor and popover. */
  offset?: number;
  role?: string;
  ariaLabel?: string;
  /** Fixed width; otherwise sized to content. */
  width?: number;
  minWidth?: number;
  zIndex?: number;
  children: ReactNode;
  "data-testid"?: string;
}

const PAD = 8;

export interface PopoverGeometry {
  top: number;
  left: number;
  maxHeight: number;
  placement: "below" | "above";
}

/** Pure placement maths (exported for tests). */
export function computePopoverGeometry(
  anchor: { top: number; bottom: number; left: number; right: number },
  pop: { width: number; height: number },
  vw: number,
  vh: number,
  align: "start" | "end",
  offset: number
): PopoverGeometry {
  const spaceBelow = vh - anchor.bottom - offset - PAD;
  const spaceAbove = anchor.top - offset - PAD;
  const placeBelow = pop.height <= spaceBelow || spaceBelow >= spaceAbove;
  const avail = Math.max(80, placeBelow ? spaceBelow : spaceAbove);
  const h = Math.min(pop.height, avail);
  const top = placeBelow ? anchor.bottom + offset : anchor.top - offset - h;
  let left = align === "end" ? anchor.right - pop.width : anchor.left;
  left = Math.min(left, vw - PAD - pop.width);
  left = Math.max(PAD, left);
  return { top: Math.max(PAD, top), left, maxHeight: avail, placement: placeBelow ? "below" : "above" };
}

export function AnchoredPopover({
  anchor,
  open,
  onClose,
  align = "end",
  offset = 4,
  role = "dialog",
  ariaLabel,
  width,
  minWidth,
  zIndex = 1000,
  children,
  "data-testid": testId,
}: AnchoredPopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  const [geo, setGeo] = useState<PopoverGeometry | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    // natural size: drop the height cap while measuring
    const prev = el.style.maxHeight;
    el.style.maxHeight = "none";
    const r = el.getBoundingClientRect();
    el.style.maxHeight = prev;
    const next = computePopoverGeometry(
      a,
      { width: width ?? r.width, height: r.height },
      window.innerWidth,
      window.innerHeight,
      align,
      offset
    );
    setGeo((g) =>
      g && g.top === next.top && g.left === next.left && g.maxHeight === next.maxHeight && g.placement === next.placement
        ? g
        : next
    );
  }, [anchor, align, offset, width]);

  useLayoutEffect(() => {
    if (!open) {
      setGeo(null);
      return;
    }
    measure();
  });

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = (): void => measure();
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    return () => {
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        anchor?.focus?.();
      }
    }
    function onDown(e: Event): void {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return; // the trigger toggles itself
      onClose();
    }
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
    };
  }, [open, onClose, anchor]);

  if (!open || !anchor || typeof document === "undefined") return null;

  const style: CSSProperties = {
    position: "fixed",
    top: geo?.top ?? 0,
    left: geo?.left ?? 0,
    visibility: geo ? "visible" : "hidden",
    width,
    minWidth,
    maxWidth: `calc(100vw - ${PAD * 2}px)`,
    maxHeight: geo?.maxHeight,
    overflowY: "auto",
    boxSizing: "border-box",
    zIndex,
  };

  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={ariaLabel}
      data-testid={testId}
      data-placement={geo?.placement}
      style={style}
    >
      {children}
    </div>,
    document.body
  );
}
