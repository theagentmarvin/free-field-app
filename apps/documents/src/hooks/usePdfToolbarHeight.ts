// apps/documents/src/hooks/usePdfToolbarHeight.ts
//
// Height (px) of the open PDF's own tool row (`.pv-toolbar`: page
// nav, zoom, fit) inside `container`, so the Documents floating
// toolbar + panel can sit BELOW it instead of covering it.
//
// The row mounts asynchronously (after the PDF loads) and wraps to
// two lines on narrow screens (`flex-wrap: wrap`), so it is observed,
// not assumed: a MutationObserver waits for it to appear, then a
// ResizeObserver follows its height. Returns 0 when `enabled` is false
// (no PDF open — the 3D surface shows and nothing occupies the band).

import { useEffect, useState, type RefObject } from "react";

export const PDF_TOOLBAR_SELECTOR = ".pv-toolbar";

export function usePdfToolbarHeight(
  container: RefObject<HTMLElement | null>,
  enabled: boolean,
): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const root = container.current;
    if (!enabled || !root) {
      setHeight(0);
      return;
    }

    let resize: ResizeObserver | null = null;
    let observed: Element | null = null;

    const measure = (): void => {
      const bar = root.querySelector<HTMLElement>(PDF_TOOLBAR_SELECTOR);
      if (bar !== observed) {
        resize?.disconnect();
        observed = bar;
        if (bar && typeof ResizeObserver !== "undefined") {
          resize = new ResizeObserver(() => {
            setHeight(bar.getBoundingClientRect().height);
          });
          resize.observe(bar);
        }
      }
      setHeight(bar ? bar.getBoundingClientRect().height : 0);
    };

    measure();
    const mutations =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(measure)
        : null;
    mutations?.observe(root, { childList: true, subtree: true });

    return () => {
      mutations?.disconnect();
      resize?.disconnect();
    };
  }, [container, enabled]);

  return height;
}
