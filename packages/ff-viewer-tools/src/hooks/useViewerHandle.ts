// packages/ff-viewer-tools/src/hooks/useViewerHandle.ts
//
// The live <IfcViewer> imperative handle as React state.
//
// The shared viewer's handle lives behind a ref object. A consumer that needs
// to (re)subscribe to the viewer (pick callbacks, selection listeners) must
// know when that handle appears or is replaced. Polling the ref every frame
// worked but treats a symptom; the keep-alive host now creates an OBSERVABLE
// ref (`createObservableRef`) that notifies when React assigns `.current`, and
// `useViewerHandle` reads it with `useSyncExternalStore`: event-driven, no
// timers, and a re-render exactly when the handle changes.
//
// A plain `RefObject` (tests, other hosts) still works: the hook reads it on
// every render and, only while it is still null (cold mount), retries on the
// next animation frame until it appears. It never polls once a handle is held.

import { useEffect, useState, useSyncExternalStore, type MutableRefObject, type RefObject } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

export interface ObservableRef<T> extends MutableRefObject<T | null> {
  /** Called after every assignment of `.current`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** A ref object (React assigns `.current` as usual) that notifies subscribers. */
export function createObservableRef<T>(): ObservableRef<T> {
  let value: T | null = null;
  const listeners = new Set<() => void>();
  return {
    get current(): T | null {
      return value;
    },
    set current(next: T | null) {
      if (next === value) return;
      value = next;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function isObservable<T>(ref: RefObject<T>): ref is ObservableRef<T> & RefObject<T> {
  return typeof (ref as Partial<ObservableRef<T>>).subscribe === "function";
}

const NEVER = (): (() => void) => () => undefined;

export function useViewerHandle(viewerRef: RefObject<IfcViewerHandle>): IfcViewerHandle | null {
  const observable = isObservable(viewerRef);
  // Observable ref: event-driven.
  const live = useSyncExternalStore(
    observable ? (viewerRef as ObservableRef<IfcViewerHandle>).subscribe : NEVER,
    () => (observable ? viewerRef.current : null),
    () => null,
  );
  // Plain ref: read each render; if still empty, retry once per frame until set.
  const [, force] = useState(0);
  const plain = observable ? null : viewerRef.current;
  useEffect(() => {
    if (observable || plain) return;
    let raf = 0;
    const tick = (): void => {
      if (viewerRef.current) force((n) => n + 1);
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [observable, plain, viewerRef]);
  return observable ? live : plain;
}
