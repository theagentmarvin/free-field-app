import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { createObservableRef, useViewerHandle } from "../../src/hooks/useViewerHandle";

describe("createObservableRef / useViewerHandle", () => {
  it("notifies subscribers when .current is assigned (and only on a change)", () => {
    const ref = createObservableRef<object>();
    let n = 0;
    const off = ref.subscribe(() => { n += 1; });
    const a = {};
    ref.current = a;
    ref.current = a; // same value: no event
    ref.current = null;
    expect(n).toBe(2);
    off();
    ref.current = {};
    expect(n).toBe(2);
  });

  it("returns the live handle as state and re-renders on replacement", () => {
    const ref = createObservableRef<object>();
    const { result } = renderHook(() => useViewerHandle(ref as never));
    expect(result.current).toBeNull();
    const a = { id: "a" };
    act(() => { ref.current = a; });
    expect(result.current).toBe(a);
    const b = { id: "b" };
    act(() => { ref.current = b; });
    expect(result.current).toBe(b);
  });
});
