// apps/models/__tests__/hooks/useViewerSelectionSync.test.tsx
//
// Task 21 — bridge between modelsToolStore.selection and the
// IfcViewerHandle. The hook reads the store via a Zustand selector
// and runs a useEffect on every change: when the store has a
// selection, call `viewerRef.current.selectElement(...)`; when
// it's null, call `viewerRef.current.clearSelection()`.
//
// The tests render a minimal component that wires the hook with a
// mock ref and verify the call dispatch on store mutations. We do
// NOT need a real IfcViewer here — the handle is a mock that
// records the calls.

import { useRef } from "react";
import { act, render } from "@testing-library/react";

import type { IfcViewerHandle } from "@ff/viewer-react";

import { useViewerSelectionSync } from "../../src/hooks/useViewerSelectionSync";
import { useModelsToolStore } from "../../src/modelsToolStore";

/**
 * Minimal harness — owns the ref, exposes the mock handle through
 * it, and renders the hook. The ref is created once via `useRef`
 * and its `current` is set to the test's mock handle in a
 * useEffect (NOT during render — that's a side effect on every
 * render and React doesn't observe ref.current mutations).
 */
function Harness({
  handle,
}: {
  handle: IfcViewerHandle;
}): JSX.Element {
  const ref = useRef<IfcViewerHandle>(handle);
  // Sync ref.current → test mock on every render so the hook's
  // viewerRef.current always points at the mock. (The hook reads
  // `viewerRef.current` inside its useEffect — it does NOT
  // depend on ref identity.)
  ref.current = handle;
  useViewerSelectionSync(ref);
  return <div data-testid="harness" />;
}

function makeMockHandle(): {
  selectElementCalls: Array<{ modelId: string | null; expressId: number | null }>;
  clearSelectionCalls: number;
  handle: IfcViewerHandle;
} {
  const selectElementCalls: Array<{ modelId: string | null; expressId: number | null }> = [];
  let clearSelectionCalls = 0;
  // Stateful tracking so `getSelection()` reflects past
  // selectElement/clearSelection calls. Without this, the sync
  // hook's "viewer already matches" guard would always see an
  // empty map and skip correctly.
  const internalSel = new Map<string, Set<number>>();
  const handle = {
    selectElement: (modelId: string | null, expressId: number | null): void => {
      selectElementCalls.push({ modelId, expressId });
      internalSel.clear();
      if (modelId !== null && expressId !== null) {
        internalSel.set(modelId, new Set([expressId]));
      }
    },
    clearSelection: (): void => {
      clearSelectionCalls++;
      internalSel.clear();
    },
    getSelection: (): ReadonlyMap<string, ReadonlySet<number>> => {
      return new Map(internalSel);
    },
    onSelectionChange: (): void => undefined,
    loadedModelIds: new Set<string>(),
    update: async (): Promise<void> => undefined,
    openLevel: async (): Promise<boolean> => false,
    closeLevel: (): void => undefined,
    pickWorldPoint: async (): Promise<{ x: number; y: number; z: number } | null> => null,
    worldToScreen: (): { x: number; y: number } | null => null,
    getContainer: (): HTMLDivElement | null => null,
    zoom: (): void => undefined,
    setActiveTool: (): void => undefined,
    setElementVisibility: (): void => undefined,
    setOnElementPick: (): void => undefined,
  } as unknown as IfcViewerHandle;
  // We expose counters via a separate object that the test reads
  // directly (closure variables). Using property assignment on
  // the handle would freeze the value at construction time —
  // JS doesn't sync plain property reads with closure mutations.
  return {
    handle,
    // The test reads `mock.selectElementCalls` and
    // `mock.clearSelectionCalls` — both backed by the SAME
    // closure variables the handle's methods mutate.
    get selectElementCalls(): typeof selectElementCalls {
      return selectElementCalls;
    },
    get clearSelectionCalls(): number {
      return clearSelectionCalls;
    },
  };
}

describe("useViewerSelectionSync (Task 21)", () => {
  beforeEach(() => {
    // Reset store before each test — selection is transient.
    useModelsToolStore.setState({ selection: null });
  });

  it("calls viewerRef.selectElement when store.selection becomes non-null", () => {
    const mock = makeMockHandle();
    render(<Harness handle={mock.handle} />);
    expect(mock.selectElementCalls.length).toBe(0);

    act(() => {
      useModelsToolStore.getState().selectElement({
        modelId: "m-1",
        expressId: 42,
      });
    });

    expect(mock.selectElementCalls).toEqual([
      { modelId: "m-1", expressId: 42 },
    ]);
    expect(mock.clearSelectionCalls).toBe(0);
  });

  it("calls viewerRef.clearSelection when store.selection becomes null", () => {
    const mock = makeMockHandle();
    render(<Harness handle={mock.handle} />);

    act(() => {
      useModelsToolStore.getState().selectElement({
        modelId: "m-1",
        expressId: 42,
      });
    });
    expect(mock.clearSelectionCalls).toBe(0);

    act(() => {
      useModelsToolStore.getState().clearSelection();
    });
    // The hook should re-fire on every store mutation. Initial
    // mount with null selection is a no-op (we explicitly don't
    // call clearSelection at mount time so the viewer's initial
    // state stays untouched). clearSelection() flips the store
    // from {m-1, 42} → null, which triggers one call.
    expect(mock.clearSelectionCalls).toBe(1);
  });

  it("dispatches per store change (multiple selections in a row)", () => {
    const mock = makeMockHandle();
    render(<Harness handle={mock.handle} />);

    act(() => {
      useModelsToolStore.getState().selectElement({
        modelId: "m-1",
        expressId: 42,
      });
    });
    act(() => {
      useModelsToolStore.getState().selectElement({
        modelId: "m-2",
        expressId: 99,
      });
    });
    act(() => {
      useModelsToolStore.getState().clearSelection();
    });

    expect(mock.selectElementCalls).toEqual([
      { modelId: "m-1", expressId: 42 },
      { modelId: "m-2", expressId: 99 },
    ]);
    expect(mock.clearSelectionCalls).toBe(1);
  });

  it("does NOT call viewerRef when initial store.selection is null (no-op mount)", () => {
    const mock = makeMockHandle();
    render(<Harness handle={mock.handle} />);
    // Hook should NOT fire on mount with a null selection. (If it
    // did, every Models session would issue a redundant
    // clearSelection call on viewer mount.)
    expect(mock.selectElementCalls.length).toBe(0);
    expect(mock.clearSelectionCalls).toBe(0);
  });
});