import { useEffect, useState } from "react";

/**
 * `(min-width: 768px)` media-query hook (Wave 5A). Drives the
 * table-vs-cards switch in <TasksApp> and the picker's popover-vs-
 * bottom-sheet choice. Defaults to `true` when `matchMedia` is absent
 * (ssr / node test env) so a consumer never render-flashes an empty
 * branch; tests stub `window.matchMedia` to pin either layout.
 */
export function useIsWide(query = "(min-width: 768px)"): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // legacy path (older Safari)
    mql.addListener?.(onChange);
    return () => mql.removeListener?.(onChange);
  }, [query]);

  return matches;
}