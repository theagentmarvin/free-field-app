// apps/documents/src/compare/useAutoRun.ts
//
// Debounced auto-run: when both sides are set and sides/settings change,
// re-run the comparison. Lives in the panel (not the store). On mount an
// existing result is kept (re-opening the panel must not recompute).

import { useEffect, useRef } from "react";

import { useCompareStore } from "./compareStore";
import type { RunCompare } from "./types";

export const AUTO_RUN_DEBOUNCE_MS = 300;

export function useAutoRun(runner: RunCompare, enabled = true): void {
  const base = useCompareStore((s) => s.base);
  const revision = useCompareStore((s) => s.revision);
  const settings = useCompareStore((s) => s.settings);
  const first = useRef(true);

  useEffect(() => {
    const isFirst = first.current;
    first.current = false;
    if (!enabled || !base || !revision) return;
    const st = useCompareStore.getState();
    if (isFirst && (st.result !== null || st.status === "running")) return;
    const t = setTimeout(() => {
      void useCompareStore.getState().run(runner);
    }, AUTO_RUN_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [enabled, base, revision, settings, runner]);
}
