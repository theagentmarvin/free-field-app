// Wave 63 — PDF overlay opacity slider in the Linkview viewer toolbar.
import { describe, expect, it, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import LinkviewToolbar from "../src/LinkviewToolbar";
import {
  DEFAULT_OVERLAY_OPACITY_PCT,
  OVERLAY_OPACITY_STORAGE_KEY,
  loadOverlayOpacityPct,
  normalizeOverlayOpacityPct,
  useOverlayOpacityStore,
} from "../src/overlayOpacityStore";

beforeEach(() => {
  window.localStorage.clear();
  useOverlayOpacityStore.setState({ pct: DEFAULT_OVERLAY_OPACITY_PCT });
});

describe("LinkviewToolbar — PDF opacity slider (wave 63)", () => {
  it("is hidden outside Overlap mode", () => {
    render(<LinkviewToolbar getHandle={() => null} projectId="p" />);
    expect(screen.queryByTestId("linkview-toolbar-overlay-opacity")).toBeNull();
  });

  it("shows a labelled 0–100 range defaulting to 85% in Overlap mode", () => {
    render(<LinkviewToolbar getHandle={() => null} projectId="p" showOverlayOpacity />);
    const slider = screen.getByLabelText("PDF opacity") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.value).toBe("85");
    expect(slider.getAttribute("aria-valuetext")).toBe("85%");
    expect(screen.getByTestId("linkview-toolbar-overlay-opacity-value").textContent).toBe("85%");
  });

  it("changing the slider updates the shared store and persists it", () => {
    render(<LinkviewToolbar getHandle={() => null} projectId="p" showOverlayOpacity />);
    const slider = screen.getByLabelText("PDF opacity");
    fireEvent.change(slider, { target: { value: "40" } });
    expect(useOverlayOpacityStore.getState().pct).toBe(40);
    expect(window.localStorage.getItem(OVERLAY_OPACITY_STORAGE_KEY)).toBe("40");
    expect(screen.getByTestId("linkview-toolbar-overlay-opacity-value").textContent).toBe("40%");
  });
});

describe("overlayOpacityStore persistence", () => {
  it("loads the persisted value, falling back to the default for junk", () => {
    expect(loadOverlayOpacityPct()).toBe(85);
    window.localStorage.setItem(OVERLAY_OPACITY_STORAGE_KEY, "60");
    expect(loadOverlayOpacityPct()).toBe(60);
    window.localStorage.setItem(OVERLAY_OPACITY_STORAGE_KEY, "abc");
    expect(loadOverlayOpacityPct()).toBe(85);
  });

  it("normalizes to an integer 0..100", () => {
    expect(normalizeOverlayOpacityPct(150)).toBe(100);
    expect(normalizeOverlayOpacityPct(-3)).toBe(0);
    expect(normalizeOverlayOpacityPct(42.6)).toBe(43);
  });
});
