// packages/ff-viewer-tools/src/hooks/useIsMobile.ts
//
// Task 36 — the single breakpoint primitive for the mobile pass.
//
// Every layout switch in the app (bottom tab bar, top-sheet
// sidebars, stacked Linkview panes) reads the breakpoint from HERE
// — no scattered `window.innerWidth` reads, no CSS-only
// breakpoints that would disagree with the JS layout.
//
// Contract:
//   useIsMobile(maxWidth = 767) → true when the viewport is
//   ≤ maxWidth CSS pixels.
//
// "≤ maxWidth" matches the CSS side exactly:
//   @media (max-width: 767px)  ⇔  matchMedia("(max-width: 767px)")
// so the JS layout and the CSS rules in apps/settings/index.html
// flip at the same width.
//
// SSR-safe: on the server (and in a jsdom test without
// matchMedia) the hook reports `false` — the desktop layout —
// and never touches `window` during render.

import { useEffect, useState } from "react";

/** Default breakpoint: the largest width that still counts as
 *  "phone". 768px is the first tablet width; everything below it
 *  gets the stacked / bottom-bar layout. */
export const DEFAULT_MOBILE_MAX_WIDTH = 767;

function getMatches(query: string): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/**
 * Returns true while the viewport is at or below `maxWidth`.
 *
 * Uses a `matchMedia` listener, so the value updates live when the
 * user rotates the phone or resizes the window — no resize polling.
 */
export function useIsMobile(
  maxWidth: number = DEFAULT_MOBILE_MAX_WIDTH,
): boolean {
  const query = `(max-width: ${maxWidth}px)`;

  const [isMobile, setIsMobile] = useState<boolean>(() => getMatches(query));

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (typeof window.matchMedia !== "function") return;

    const mql = window.matchMedia(query);

    // Sync once on mount: the media query may have flipped between
    // the initial render and this effect (rare, but cheap to guard).
    setIsMobile(mql.matches);

    const onChange = (event: MediaQueryListEvent): void => {
      setIsMobile(event.matches);
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }

    // Safari < 14 — the legacy listener API.
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, [query]);

  return isMobile;
}

export default useIsMobile;
