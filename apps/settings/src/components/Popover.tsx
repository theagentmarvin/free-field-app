// src/components/Popover.tsx
//
// A small dropdown surface that escapes overflow clipping by
// rendering through a React portal at document.body. Used by the
// AssignMenu (PDF → folder picker) and the FolderRowMenu
// (folder kebab → rename / new subfolder / delete) so the menu
// always sits above sibling content and never gets clipped by
// `overflow: auto` on a scroll container.
//
// The host renders a trigger element (a button). On open, the
// host measures the trigger's bounding rect and renders the
// popover anchored below it (or above, if there's no room).
// Closing is the host's responsibility — pass `onClose` so a
// click outside dismisses.
//
// Why a portal instead of `position: fixed` on a parent:
//   - `position: fixed` is positioned relative to the viewport,
//     which is what we want, but the host tree's `overflow:
//     auto` containers DO NOT clip fixed descendants when the
//     ancestors have `transform` / `filter` / `perspective`
//     (which would create a new containing block). React's
//     portals guarantee the menu renders at document.body,
//     immune to ancestor stacking-context weirdness.
//   - Future: a real design system would extract this as a
//     shared primitive; for now we duplicate the pattern
//     deliberately inside this single module.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type PopoverPlacement = "below-right" | "below-left" | "above-right" | "above-left";

export interface PopoverProps {
  /** The trigger element. The popover positions itself relative
   *  to this element's bounding rect. */
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Pixel gap between the anchor and the popover. */
  offset?: number;
  /** Default placement; the popover auto-flips if there isn't
   *  room in the chosen direction (e.g., near the viewport
   *  bottom). */
  placement?: PopoverPlacement;
  /** Optional fixed width; otherwise the popover sizes to its
   *  content (min 160). */
  width?: number;
  /** ARIA role for the popover's surface. */
  role?: string;
  /** Highest z-index in the app is 300 (`--ff-z-modal`); we
   *  use a slightly higher value to sit above anything else
   *  that hasn't been explicitly z-indexed. */
  zIndex?: number;
  children: ReactNode;
  /** Forwarded for tests. */
  "data-testid"?: string;
}

const DEFAULT_OFFSET = 6;
const DEFAULT_Z = 1000;
const VIEWPORT_PAD = 8;

interface ComputedPosition {
  top: number;
  left: number;
}

export default function Popover({
  anchor,
  open,
  onClose,
  offset = DEFAULT_OFFSET,
  placement = "below-right",
  width,
  role,
  zIndex = DEFAULT_Z,
  children,
  "data-testid": testId,
}: PopoverProps): ReactNode | null {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<ComputedPosition | null>(null);
  const [resolvedPlacement, setResolvedPlacement] = useState<PopoverPlacement>(placement);

  // Compute position on open + on resize/scroll of the anchor's
  // ancestors. We re-measure on every render of the popover
  // content (cheap — a single getBoundingClientRect call) so
  // dynamic content doesn't push the popover out of bounds.
  const measure = useCallback(() => {
    if (!anchor || !popoverRef.current) return;
    const rect = anchor.getBoundingClientRect();
    const pop = popoverRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Try the requested placement first; flip if it would clip
    // the viewport.
    const popW = width ?? pop.width;
    const popH = pop.height;

    const tryBelow = placement.startsWith("below");
    const wantRight = placement.endsWith("right");

    let top = tryBelow ? rect.bottom + offset : rect.top - offset - popH;
    let left = wantRight ? rect.right - popW : rect.left;

    // Flip vertically if it would overflow the viewport bottom
    // (with a small grace pad).
    if (tryBelow && top + popH > vh - VIEWPORT_PAD) {
      top = rect.top - offset - popH;
    } else if (!tryBelow && top < VIEWPORT_PAD) {
      top = rect.bottom + offset;
    }
    // Flip horizontally if it would overflow the viewport right.
    if (left + popW > vw - VIEWPORT_PAD) {
      left = vw - VIEWPORT_PAD - popW;
    }
    if (left < VIEWPORT_PAD) {
      left = VIEWPORT_PAD;
    }

    setPosition({ top, left });
    // Track the resolved placement for tests (data-placement attr).
    // We don't actually use the value to re-render — the position
    // is already what the user sees — but tests assert on it.
    const resolved: PopoverPlacement =
      top < rect.top
        ? (placement.replace("below", "above") as PopoverPlacement)
        : top > rect.top
        ? (placement.replace("above", "below") as PopoverPlacement)
        : placement;
    setResolvedPlacement(resolved);
  }, [anchor, offset, placement, width]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    measure();
    // Re-measure on viewport resize so the popover stays anchored.
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, measure]);

  // Close on Escape; close on outside click (the popover's own
  // backdrop handles this — see below).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !anchor || typeof document === "undefined") return null;

  const style: CSSProperties = {
    position: "fixed",
    top: position?.top ?? 0,
    left: position?.left ?? 0,
    minWidth: 160,
    width: width ?? undefined,
    background: "var(--ff-bg-app)",
    border: "1px solid var(--ff-border)",
    borderRadius: 4,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
    padding: 4,
    zIndex,
  };

  return createPortal(
    <>
      {/* Full-viewport backdrop for click-outside dismissal.
          Rendered FIRST so the popover's own events bubble
          naturally and the backdrop stays behind them. */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: zIndex - 1,
        }}
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={popoverRef}
        role={role}
        data-testid={testId}
        data-placement={resolvedPlacement}
        style={style}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}