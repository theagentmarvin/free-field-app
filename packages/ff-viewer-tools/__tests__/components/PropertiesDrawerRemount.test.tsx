// The shared IfcViewer's imperative handle can be replaced behind the SAME ref
// object (viewer rebuilt by an error-boundary retry, host change). The pick
// subscription follows the live handle, event-driven: no polling once a handle
// is held, and a re-subscribe exactly when it changes.
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

import PropertiesDrawer from "../../src/components/PropertiesDrawer";
import { createObservableRef } from "../../src/hooks/useViewerHandle";
import { useModelsToolStore } from "../../src/modelsToolStore";
import { testDataSource } from "../support/testDb";
import { renderWithDataSource } from "../support/renderWithDataSource";

function handle() {
  return { setOnElementPick: vi.fn(), getElementData: vi.fn(async () => []) };
}
const fns = (h: ReturnType<typeof handle>) => h.setOnElementPick.mock.calls.filter((c) => typeof c[0] === "function");

describe("PropertiesDrawer follows the live viewer handle", () => {
  beforeEach(() => useModelsToolStore.getState().clearSelection());

  it("re-subscribes when the handle behind an observable ref is replaced", async () => {
    const a = handle();
    const ref = createObservableRef<IfcViewerHandle>();
    ref.current = a as unknown as IfcViewerHandle;
    renderWithDataSource(<PropertiesDrawer viewerRef={ref as unknown as RefObject<IfcViewerHandle>} variant="body" />, { dataSource: testDataSource });
    await vi.waitFor(() => expect(fns(a)).toHaveLength(1));

    const b = handle();
    act(() => {
      ref.current = b as unknown as IfcViewerHandle;
    });
    // immediately (an event, not a poll): old viewer unsubscribed, new one subscribed
    expect(a.setOnElementPick).toHaveBeenLastCalledWith(null);
    expect(fns(b)).toHaveLength(1);

    const cb = fns(b)[0]![0] as (e: unknown) => void;
    await act(async () => cb({ modelId: "m", expressId: 5, point: null }));
    expect(useModelsToolStore.getState().selection).toEqual({ modelId: "m", expressId: 5 });
  });

  it("subscribes once the handle first appears (cold mount) and does not resubscribe while unchanged", async () => {
    const ref = createObservableRef<IfcViewerHandle>();
    renderWithDataSource(<PropertiesDrawer viewerRef={ref as unknown as RefObject<IfcViewerHandle>} variant="body" />, { dataSource: testDataSource });
    const a = handle();
    act(() => {
      ref.current = a as unknown as IfcViewerHandle;
    });
    expect(fns(a)).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    expect(fns(a)).toHaveLength(1);
  });

  it("a plain ref still works on a cold mount (waits for the handle, then stops polling)", async () => {
    const ref = { current: null } as { current: unknown };
    const raf = vi.spyOn(window, "requestAnimationFrame");
    renderWithDataSource(<PropertiesDrawer viewerRef={ref as RefObject<IfcViewerHandle>} variant="body" />, { dataSource: testDataSource });
    const a = handle();
    ref.current = a;
    await vi.waitFor(() => expect(fns(a)).toHaveLength(1));
    const frames = raf.mock.calls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(raf.mock.calls.length).toBe(frames); // no per-frame polling once a handle is held
    raf.mockRestore();
  });
});
