/**
 * Where a fresh page load starts.
 *
 * Every visit that opens the bare app root (`/`) starts in the Models
 * viewer. Settings stays at `/` and is reached from the rail as
 * before; only the ENTRY is redirected, once, before React mounts, so
 * there is no Settings flash and no history entry for `/`.
 *
 * Why Models first: it is the module that owns the viewer's load
 * pass. Starting elsewhere and switching to Models while the models
 * are still streaming re-hosts the shared viewer mid-load (see
 * `ModelUnloadedError` in @ff/viewer-react for the race this avoids).
 */
export const ENTRY_ROUTE = "/models";

export function redirectEntryToModels(
  loc: Pick<Location, "pathname" | "search" | "hash"> = window.location,
  history: Pick<History, "replaceState" | "state"> = window.history,
): boolean {
  if (loc.pathname !== "/") return false;
  history.replaceState(history.state, "", `${ENTRY_ROUTE}${loc.search}${loc.hash}`);
  return true;
}
