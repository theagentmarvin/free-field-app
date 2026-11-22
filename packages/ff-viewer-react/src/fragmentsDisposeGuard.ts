// src/fragmentsDisposeGuard.ts
//
// Wave 73: make `FragmentsManager.core` safe to read after `dispose()`.
//
// The engine clears its private core on dispose, and its `core` getter then
// throws "FragmentsManager not initialized. Call init() first.". A consumer
// that holds the manager it was handed through `registerFragments` /
// `onReady` and does bookkeeping after the viewer unmounted (listing models,
// asking for a refresh, closing buffers) used to crash on that. After this
// guard is installed, a DISPOSED manager's `core` is an inert, empty core:
// no models, `update()` / `raycast()` resolve to nothing, `dispose()` is a
// no-op. A manager that was never initialised still throws exactly as before
// (that is a real programming error, not post-dispose bookkeeping).
//
// `disposeFragmentsManager` is the idempotent dispose the viewer itself uses
// (the engine's own dispose already tolerates a second call; this also never
// rejects).

/** The empty core handed out after dispose. Frozen; shared. */
export interface DisposedFragmentsCore {
  readonly disposed: true;
  readonly models: { readonly list: ReadonlyMap<string, never> };
  update(force?: boolean): Promise<void>;
  raycast(data?: unknown): Promise<null>;
  dispose(): void;
}

export const DISPOSED_FRAGMENTS_CORE: DisposedFragmentsCore = Object.freeze({
  disposed: true as const,
  models: Object.freeze({ list: new Map<string, never>() }),
  update: () => Promise.resolve(),
  raycast: () => Promise.resolve(null),
  dispose: () => undefined,
});

/**
 * Record the viewer's base coordinates on the fragments core. A load that
 * outlives its viewer (unmount, building switch, StrictMode remount) sees the
 * frozen DISPOSED core, where assigning a new property throws "object is not
 * extensible" and the stale load logged a failure. Returns false (nothing
 * written) for such a core.
 */
export function setBaseCoordinates(
  core: { baseCoordinates: [number, number, number] | null },
  coords: [number, number, number],
): boolean {
  if (!Object.isExtensible(core) || Object.isFrozen(core)) return false;
  core.baseCoordinates = coords;
  return true;
}

interface ManagerLike {
  dispose?: () => unknown;
}

const disposedManagers = new WeakSet<object>();
const guardedManagers = new WeakSet<object>();

function findAccessor(obj: object, name: string): PropertyDescriptor | undefined {
  for (let o: object | null = obj; o; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d) return d;
  }
  return undefined;
}

/**
 * Install the post-dispose guard on one manager instance (idempotent).
 * Call it right after the manager is created / initialised.
 */
export function guardFragmentsManager(manager: object | null | undefined): void {
  if (!manager || guardedManagers.has(manager)) return;
  const m = manager as ManagerLike;
  const coreDesc = findAccessor(manager, "core");
  if (!coreDesc?.get) return; // engine shape drift / test double: leave it alone
  guardedManagers.add(manager);

  const origDispose = typeof m.dispose === "function" ? m.dispose.bind(manager) : null;
  if (origDispose) {
    Object.defineProperty(manager, "dispose", {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): unknown => {
        // Mark first: the engine's own dispose reads `this.core` while
        // tearing down, and must still get the REAL core on that call.
        const result = (origDispose as (...a: unknown[]) => unknown)(...args);
        disposedManagers.add(manager);
        return result;
      },
    });
  }
  Object.defineProperty(manager, "core", {
    configurable: true,
    enumerable: coreDesc.enumerable ?? false,
    get(): unknown {
      if (disposedManagers.has(manager)) return DISPOSED_FRAGMENTS_CORE;
      return (coreDesc.get as () => unknown).call(manager);
    },
  });
}

/** True once a guarded manager has been disposed. */
export function isFragmentsManagerDisposed(manager: object | null | undefined): boolean {
  return !!manager && disposedManagers.has(manager);
}

/**
 * Dispose a manager at most once; never throws, never rejects. Safe to call
 * on a manager the engine's component cascade already disposed.
 */
export async function disposeFragmentsManager(
  manager: ManagerLike | null | undefined,
): Promise<void> {
  if (!manager || disposedManagers.has(manager as object)) return;
  try {
    await manager.dispose?.();
  } catch {
    // a second / partial dispose must not surface
  } finally {
    // Cover managers the guard was never installed on.
    disposedManagers.add(manager as object);
  }
}
