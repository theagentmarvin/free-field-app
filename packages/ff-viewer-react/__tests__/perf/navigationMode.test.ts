import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NavigationModeController,
  NAVIGATION_IDLE_MS,
  NAVIGATION_SETTLE_DELAY_MS,
} from "../../src/perf/navigationMode";

/** camera-controls style event target. */
function fakeControls() {
  const l: Record<string, Array<() => void>> = {};
  return {
    l,
    addEventListener(type: string, cb: () => void) {
      (l[type] ??= []).push(cb);
    },
    removeEventListener(type: string, cb: () => void) {
      const a = l[type];
      if (a) a.splice(a.indexOf(cb), 1);
    },
    emit(type: string) {
      for (const cb of [...(l[type] ?? [])]) cb();
    },
  };
}

function setup(settleDelayMs = 0) {
  const ctl = fakeControls();
  const onStart = vi.fn();
  const onStop = vi.fn();
  const onSettle = vi.fn();
  const nav = new NavigationModeController({
    onStart,
    onStop,
    onSettle,
    settleDelayMs,
  });
  nav.attach(ctl);
  return { ctl, nav, onStart, onStop, onSettle };
}

describe("NavigationModeController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enters motion on user control (drag step or wheel notch) and leaves on rest", () => {
    const { ctl, nav, onStart, onStop, onSettle } = setup();
    ctl.emit("control");
    expect(nav.moving).toBe(true);
    ctl.emit("control");
    ctl.emit("update");
    expect(onStart).toHaveBeenCalledTimes(1);
    ctl.emit("rest");
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledWith("rest");
    expect(onSettle).toHaveBeenCalledWith("rest");
  });

  it("a click (controlstart without control) never enters motion", () => {
    const { ctl, nav, onStart } = setup();
    ctl.emit("controlstart");
    ctl.emit("controlend");
    vi.advanceTimersByTime(1000);
    expect(nav.moving).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("leaves motion on sleep too", () => {
    const { ctl, nav, onStop } = setup();
    ctl.emit("control");
    ctl.emit("sleep");
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledWith("sleep");
  });

  it("safety timer: no camera event for idleMs ends motion (missed rest)", () => {
    const { ctl, nav, onStop, onSettle } = setup();
    ctl.emit("control");
    vi.advanceTimersByTime(NAVIGATION_IDLE_MS - 50);
    ctl.emit("update"); // still moving (damping) — re-arms
    vi.advanceTimersByTime(NAVIGATION_IDLE_MS - 50);
    expect(nav.moving).toBe(true);
    vi.advanceTimersByTime(100);
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledWith("idle");
    expect(onSettle).toHaveBeenCalledWith("idle");
  });

  it("programmatic transitions enter motion on their first update and end with a settle", () => {
    const { ctl, nav, onStart, onStop } = setup();
    ctl.emit("transitionstart");
    expect(nav.moving).toBe(false);
    ctl.emit("wake");
    ctl.emit("update");
    expect(nav.moving).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
    ctl.emit("update");
    ctl.emit("rest");
    expect(onStop).toHaveBeenCalledWith("rest");
  });

  it("an instant programmatic jump (update then sleep) settles without entering motion", () => {
    const { ctl, nav, onStart, onSettle } = setup();
    ctl.emit("update");
    expect(nav.moving).toBe(false);
    ctl.emit("sleep");
    expect(onStart).not.toHaveBeenCalled();
    expect(onSettle).toHaveBeenCalledWith("sleep");
  });

  it("a transition that never moves settles via the safety timer", () => {
    const { ctl, onSettle } = setup();
    ctl.emit("transitionstart");
    vi.advanceTimersByTime(NAVIGATION_IDLE_MS + 1);
    expect(onSettle).toHaveBeenCalledWith("idle");
  });

  it("damping updates after rest do not re-enter motion", () => {
    const { ctl, nav, onStart } = setup();
    ctl.emit("control");
    ctl.emit("rest");
    ctl.emit("update");
    ctl.emit("update");
    expect(nav.moving).toBe(false);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("ignores rest/sleep while a pointer drag is in progress (frames without input)", () => {
    const { ctl, nav, onStop } = setup();
    ctl.emit("controlstart");
    ctl.emit("control");
    ctl.emit("sleep"); // a frame without pointer movement
    ctl.emit("rest");
    expect(nav.moving).toBe(true);
    ctl.emit("control");
    ctl.emit("controlend");
    ctl.emit("rest");
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("holding the pointer still mid-drag ends motion via the idle timer", () => {
    const { ctl, nav, onStop } = setup();
    ctl.emit("controlstart");
    ctl.emit("control");
    vi.advanceTimersByTime(NAVIGATION_IDLE_MS + 1);
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledWith("idle");
  });

  it("delays the settle so the next wheel notch keeps motion mode", () => {
    const { ctl, nav, onStop, onStart } = setup(NAVIGATION_SETTLE_DELAY_MS);
    ctl.emit("control"); // wheel notch
    ctl.emit("rest");
    vi.advanceTimersByTime(NAVIGATION_SETTLE_DELAY_MS - 20);
    ctl.emit("control"); // next notch cancels the pending settle
    vi.advanceTimersByTime(100);
    expect(nav.moving).toBe(true);
    ctl.emit("rest");
    vi.advanceTimersByTime(NAVIGATION_SETTLE_DELAY_MS);
    expect(nav.moving).toBe(false);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("stop() forces rest; it is a no-op when idle", () => {
    const { ctl, nav, onStop, onSettle } = setup();
    nav.stop();
    expect(onSettle).not.toHaveBeenCalled();
    ctl.emit("control");
    nav.stop();
    expect(nav.moving).toBe(false);
    expect(onStop).toHaveBeenCalledWith("manual");
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it("dispose() restores (onStop) when moving and detaches every listener", () => {
    const { ctl, nav, onStop } = setup();
    ctl.emit("control");
    nav.dispose();
    expect(onStop).toHaveBeenCalledWith("manual");
    expect(Object.values(ctl.l).every((a) => a.length === 0)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
