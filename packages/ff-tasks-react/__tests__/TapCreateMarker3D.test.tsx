// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TapCreateMarker3D } from "../src/TapCreateMarker3D";
import type { CalloutHandle, PinPose } from "../src/callouts";

/**
 * Seam test for the 3D tap-to-create + marker (Wave 5B). The marker is
 * pure of Firebase — it only needs a structural `CalloutHandle` — so
 * no auth/Firestore/Dexie mocks are required. What's under test: the
 * selection → bbox-centre → projected + button, and the tap emitting
 * the EXACT `TaskLocation` shape the compose→outbox pipeline expects
 * (this is the contract with the outbox, asserted by payload equality).
 */

const POSE: PinPose = { pos: [0, 0, 5], target: [1, 2, 3], fov: 45, isOrtho: false };

function makeHandle() {
  const state = {
    selection: new Map<string, Set<number>>(),
    center: { x: 1, y: 2, z: 3 } as { x: number; y: number; z: number } | null,
    // wave 20: the viewer already stashed the true click point…
    picked: null as { x: number; y: number; z: number } | null,
    // wave 21: true while the depth pass is still in flight (id pass
    // already applied the selection); default false = programmatic
    pending: false,
    screen: { x: 100, y: 150 } as { x: number; y: number } | null,
  };
  const handle: CalloutHandle = {
    getSelection: () => state.selection,
    getSelectionWorldCenter: () => Promise.resolve(state.center),
    getSelectionWorldPoint: () => state.picked,
    isSelectionPointPending: () => state.pending,
    worldToScreen: () => state.screen,
    getPose: () => POSE,
  };
  return { handle, state };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("TapCreateMarker3D", () => {
  it("renders no marker while nothing is selected", async () => {
    const { handle } = makeHandle();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={vi.fn()} />);
    await waitFor(() => expect(screen.queryByLabelText("Add task here")).toBeNull());
  });

  it("shows the + marker at the projected bbox centre when an element is selected", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={vi.fn()} />);

    const marker = await screen.findByLabelText("Add task here");
    expect(marker).toBeTruthy();
    expect(marker.style.left).toBe("100px");
    expect(marker.style.top).toBe("150px");
  });

  it("tapping the marker emits the exact TaskLocation the outbox expects", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} storeyName="Level 2" onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));

    expect(onCreate).toHaveBeenCalledTimes(1);
    // payload equality — this is the contract with the outbox pipeline
    expect(onCreate.mock.calls[0][0]).toEqual({
      storeyName: "Level 2",
      bim: {
        elements: [{ modelId: "m1", expressId: 5 }],
        worldPoint: [1, 2, 3],
        cameraPose: POSE,
      },
      pdf: null,
    });
  });

  it("wave 20: anchors at the REAL click point when the viewer stashed one", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    state.picked = { x: 9, y: 8, z: 7 };
    const centerSpy = vi.fn(() => Promise.resolve(state.center));
    handle.getSelectionWorldCenter = centerSpy;
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));

    // the click point wins over the bbox centre…
    expect(onCreate.mock.calls[0][0].bim.worldPoint).toEqual([9, 8, 7]);
    // …and the boxer never even runs for a canvas-pick selection
    expect(centerSpy).not.toHaveBeenCalled();
  });

  it("wave 20: falls back to the bbox centre when no click point is stashed", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    state.picked = null; // programmatic selection — no click point
    const centerSpy = vi.fn(() => Promise.resolve(state.center));
    handle.getSelectionWorldCenter = centerSpy;
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));

    expect(centerSpy).toHaveBeenCalled();
    expect(onCreate.mock.calls[0][0].bim.worldPoint).toEqual([1, 2, 3]);
  });

  it("wave 21: waits for the async depth-pass point instead of running the boxer", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    // The id pass applied the selection; the point lands ~150 ms
    // later (real depth-pass latency on device). The marker must
    // wait — NOT commit the slower bbox centre.
    state.pending = true;
    handle.getSelectionWorldPoint = vi.fn(() => state.picked);
    handle.isSelectionPointPending = vi.fn(() => state.pending);
    const centerSpy = vi.fn(async () => state.center);
    handle.getSelectionWorldCenter = centerSpy;
    setTimeout(() => {
      state.picked = { x: 9, y: 8, z: 7 };
      state.pending = false;
    }, 150);
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here", {}, { timeout: 2000 }));

    expect(onCreate.mock.calls[0][0].bim.worldPoint).toEqual([9, 8, 7]);
    expect(centerSpy).not.toHaveBeenCalled();
  });

  it("wave 21: falls through to the bbox centre when the pending pick dies without a point", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    // Pending flips false with NO point (depth pass returned void) —
    // the wait loop must bail out to the boxer, not hang.
    state.pending = true;
    handle.isSelectionPointPending = vi.fn(() => {
      state.pending = false; // clears on the very first check
      return false;
    });
    const centerSpy = vi.fn(async () => state.center);
    handle.getSelectionWorldCenter = centerSpy;
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));

    expect(centerSpy).toHaveBeenCalled();
    expect(onCreate.mock.calls[0][0].bim.worldPoint).toEqual([1, 2, 3]);
  });

  it("carries ALL selected expressIds in a federated multi-model selection", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([
      ["m1", new Set([5, 6])],
      ["m2", new Set([9])],
    ]);
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));

    const loc = onCreate.mock.calls[0][0];
    expect(loc.bim.elements).toEqual([
      { modelId: "m1", expressId: 5 },
      { modelId: "m1", expressId: 6 },
      { modelId: "m2", expressId: 9 },
    ]);
    expect(loc.bim.worldPoint).toEqual([1, 2, 3]); // combined bbox centre
  });

  it("hides the marker when the selection clears and re-shows on a new selection", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={vi.fn()} />);

    await screen.findByLabelText("Add task here");

    state.selection = new Map();
    await waitFor(() => expect(screen.queryByLabelText("Add task here")).toBeNull());

    state.selection = new Map([["m1", new Set([7])]]);
    await screen.findByLabelText("Add task here");
  });

  it("dismisses the marker after tap (compose opens) and re-arms on a new selection", async () => {
    const { handle, state } = makeHandle();
    state.selection = new Map([["m1", new Set([5])]]);
    const onCreate = vi.fn();
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={onCreate} />);

    fireEvent.click(await screen.findByLabelText("Add task here"));
    expect(onCreate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText("Add task here")).toBeNull());

    // a fresh selection re-arms the marker
    state.selection = new Map([["m1", new Set([8])]]);
    await screen.findByLabelText("Add task here");
  });
});
// ─── Wave 30: idle-frame gate ──────────────────────────────────────
//
// The marker's rAF loop used to project its anchor on EVERY frame
// — a Vector3 allocation, a matrix multiply and a forced layout read
// — even while the camera and canvas were frozen, i.e. exactly when
// the answer cannot change. It now consults the viewer's projection
// token, and falls back to the old always-project behavior for hosts
// that do not have one.

describe("TapCreateMarker3D wave 30 frame gate", () => {
  const selected = () => new Map<string, Set<number>>([["m1", new Set([5])]]);

  function gatedHandle(revision: () => number) {
    const worldToScreen = vi.fn(() => ({ x: 100, y: 150 }));
    const handle = {
      getSelection: selected,
      getSelectionWorldPoint: () => ({ x: 1, y: 2, z: 3 }),
      isSelectionPointPending: () => false,
      getSelectionWorldCenter: () => Promise.resolve({ x: 1, y: 2, z: 3 }),
      worldToScreen,
      getViewportRevision: revision,
    } as unknown as CalloutHandle;
    return { handle, worldToScreen };
  }

  it("stops projecting while the viewport token is unchanged", async () => {
    const { handle, worldToScreen } = gatedHandle(() => 7);
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={vi.fn()} />);
    await screen.findByLabelText("Add task here");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
    });

    const quiet = worldToScreen.mock.calls.length;
    expect(quiet).toBeGreaterThan(0); // it did place the marker
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    // ~12 idle frames, zero projection work.
    expect(worldToScreen.mock.calls.length).toBe(quiet);

    // …and it wakes the moment the view changes.
    let rev = 8;
    handle.getViewportRevision = () => rev;
    await waitFor(() => {
      expect(worldToScreen.mock.calls.length).toBeGreaterThan(quiet);
    });
  });

  it("keeps projecting every frame for a handle without the token", async () => {
    const worldToScreen = vi.fn(() => ({ x: 100, y: 150 }));
    const handle = {
      getSelection: selected,
      getSelectionWorldPoint: () => ({ x: 1, y: 2, z: 3 }),
      isSelectionPointPending: () => false,
      worldToScreen,
    } as unknown as CalloutHandle;
    render(<TapCreateMarker3D getHandle={() => handle} onCreate={vi.fn()} />);
    await screen.findByLabelText("Add task here");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const before = worldToScreen.mock.calls.length;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    // Pre-wave-30 behavior preserved: still O(frames), never frozen.
    expect(worldToScreen.mock.calls.length).toBeGreaterThan(before + 3);
  });
});
