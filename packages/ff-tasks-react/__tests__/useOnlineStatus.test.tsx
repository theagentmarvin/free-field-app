// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useOnlineStatus } from "../src/useOnlineStatus";

function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { value, configurable: true });
}

afterEach(() => {
  setNavigatorOnline(true);
});

describe("useOnlineStatus", () => {
  it("reflects navigator.onLine initially", () => {
    setNavigatorOnline(true);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(true);
  });

  it("starts offline when navigator.onLine is false", () => {
    setNavigatorOnline(false);
    const { result } = renderHook(() => useOnlineStatus());
    expect(result.current).toBe(false);
  });

  it("tracks online/offline events", () => {
    setNavigatorOnline(true);
    const { result } = renderHook(() => useOnlineStatus());

    act(() => {
      setNavigatorOnline(false);
      window.dispatchEvent(new Event("offline"));
    });
    expect(result.current).toBe(false);

    act(() => {
      setNavigatorOnline(true);
      window.dispatchEvent(new Event("online"));
    });
    expect(result.current).toBe(true);
  });
});