// src/viewer/ViewerHandleContext.tsx
//
// React context that hands the <IfcViewer>'s imperative handle
// ref to deeply-nested consumers. The only consumer is
// <MappedStoreysSection> (the PDF panel's "Mapped" list), which
// lives in a different subtree from <IfcViewer> and so cannot
// receive the ref as a prop.
//
// <AppShell> creates the ref, passes it to <IfcViewer
// ref={...}>, and wraps the body in <ViewerHandleProvider
// viewerRef={...}>. Any consumer that needs the viewer handle
// calls `useViewerHandle()`.

import {
  createContext,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";

import type { IfcViewerHandle } from "./IfcViewer";

export const ViewerHandleContext = createContext<
  RefObject<IfcViewerHandle> | null
>(null);

export function useViewerHandle(): RefObject<IfcViewerHandle> {
  const ref = useContext(ViewerHandleContext);
  if (!ref) {
    // Defensive: the only consumer is <MappedStoreysSection>, which
    // is only rendered when <ViewerHandleContext.Provider> wraps
    // the tree (it does, in <AppShell>). Throw clearly if that
    // contract is broken.
    throw new Error(
      "useViewerHandle must be used inside <ViewerHandleContext.Provider>",
    );
  }
  return ref;
}

export interface ViewerHandleProviderProps {
  viewerRef: RefObject<IfcViewerHandle>;
  children: ReactNode;
}

export function ViewerHandleProvider({
  viewerRef,
  children,
}: ViewerHandleProviderProps): ReactNode {
  return (
    <ViewerHandleContext.Provider value={viewerRef}>
      {children}
    </ViewerHandleContext.Provider>
  );
}
