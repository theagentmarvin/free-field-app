import { useEffect } from "react";
import { useModelsToolStore } from "@ff/viewer-tools";

/**
 * One-shot hydration for the Models tool store.
 *
 * Called once from <ModelsApp> on mount. It flips `hydrated` to true
 * so the UI can stop showing skeleton states.
 *
 * Wave 35 (toolbar-nav redesign) dropped the sidebar-width read:
 * the resizable content sidebar is gone (the canvas is full-bleed
 * and every surface floats), so the `ff:mainapp:sidebar-width`
 * key is no longer read — let it die.
 *
 * Failures (private mode, quota, etc.) are swallowed — the store
 * keeps its default values and `hydrated` is still flipped, so the
 * UI doesn't sit forever in a "loading" state.
 */
export function useModelsToolStoreHydration(): void {
  useEffect(() => {
    useModelsToolStore.getState().setHydrated(true);
  }, []);
}
