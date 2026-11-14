/**
 * Recover from a deploy that happened while this tab was open.
 *
 * Every build renames its hashed chunks (`assets/index-<hash>.js`). A
 * tab still running the previous build asks for a chunk that no longer
 * exists the first time it lazy-loads a module (Documents, LinkView…),
 * and the route shows "Failed to fetch dynamically imported module".
 * Vite reports that through the `vite:preloadError` window event; we
 * answer with ONE full reload, which fetches the new index.html and
 * its chunks. A short session guard stops a reload loop if the chunk is
 * genuinely broken — then the module's normal error UI is shown.
 */
const GUARD_KEY = "ff-stale-chunk-reload-at";
const GUARD_MS = 30_000;

export function shouldReloadForStaleChunk(
  now: number,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): boolean {
  let last = 0;
  try {
    last = Number(storage?.getItem(GUARD_KEY) ?? 0) || 0;
  } catch {
    // storage blocked: fall through and allow one reload
  }
  if (last > 0 && now - last < GUARD_MS) return false;
  try {
    storage?.setItem(GUARD_KEY, String(now));
  } catch {
    // ignore
  }
  return true;
}

export function installStaleChunkReload(win: Window = window): void {
  win.addEventListener("vite:preloadError", (event) => {
    let storage: Storage | null = null;
    try {
      storage = win.sessionStorage;
    } catch {
      storage = null;
    }
    if (!shouldReloadForStaleChunk(Date.now(), storage)) return;
    event.preventDefault();
    win.location.reload();
  });
}
