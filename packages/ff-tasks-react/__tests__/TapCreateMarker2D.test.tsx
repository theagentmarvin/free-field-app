// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TapCreateMarker2D } from "../src/TapCreateMarker2D";
import type { PdfPinSurface } from "../src/pdfPins";

/**
 * Seam test for the 2D tap-to-create + marker (Wave 5B). Pure of
 * Firebase — the marker is fed a resolved uv and only needs the
 * structural `PdfPinSurface`. Under test: the annotation-layer portal
 * (first paint gated on onReady), uv × pageSize × renderScale
 * placement, the hidden state, and the + tap → host callback. The
 * tap-vs-drag gate and the calibration gate live elsewhere and are
 * covered by `createMarker.test.ts` + `pdfPins.test.ts` respectively.
 */

interface Fake {
  surface: PdfPinSurface;
  fireReady: () => void;
  fireScale: (renderScale: number) => void;
}

function fakeSurface(widthPx = 800): Fake {
  const layer = document.createElement("div");
  layer.style.width = `${widthPx}px`;
  layer.style.height = "600px";
  document.body.appendChild(layer);

  let readyCb: (() => void) | null = null;
  let scaleCb: ((e: { renderScale: number }) => void) | null = null;

  const surface: PdfPinSurface = {
    getAnnotationLayer: () => layer,
    getTotalScale: () => 1,
    getCurrentPage: () => 1,
    goToPage: () => {},
    onReady: (cb: () => void) => {
      readyCb = cb;
    },
    setOnScaleChange: (cb: (e: { renderScale: number }) => void) => {
      scaleCb = cb;
      return () => {
        scaleCb = null;
      };
    },
  };

  return {
    surface,
    fireReady: () => readyCb?.(),
    fireScale: (renderScale: number) => scaleCb?.({ renderScale }),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("TapCreateMarker2D", () => {
  it("renders nothing when there is no pending marker uv", async () => {
    const fx = fakeSurface();
    render(
      <TapCreateMarker2D
        getSurface={() => fx.surface}
        pageSize={{ width: 800, height: 600 }}
        markerUv={null}
        onMarkerTap={vi.fn()}
      />,
    );
    fx.fireReady();
    await waitFor(() => expect(screen.queryByLabelText("Add task here")).toBeNull());
  });

  it("gates first paint on onReady and places the marker at uv × pageSize × renderScale", async () => {
    const fx = fakeSurface(1600); // layer 1600px / 800pt = renderScale 2
    render(
      <TapCreateMarker2D
        getSurface={() => fx.surface}
        pageSize={{ width: 800, height: 600 }}
        markerUv={[0.5, 0.25]}
        onMarkerTap={vi.fn()}
      />,
    );

    // before onReady the viewer hasn't settled → no marker yet
    await waitFor(() => expect(fx.surface.getAnnotationLayer()).toBeTruthy());
    expect(screen.queryByLabelText("Add task here")).toBeNull();

    fx.fireReady();
    const marker = await screen.findByLabelText("Add task here");
    // 0.5 × 800 × 2 = 800 ; 0.25 × 600 × 2 = 300
    expect(marker.style.left).toBe("800px");
    expect(marker.style.top).toBe("300px");
  });

  it("tapping the + marker hands control to the host (compose-open)", async () => {
    const fx = fakeSurface();
    const onMarkerTap = vi.fn();
    render(
      <TapCreateMarker2D
        getSurface={() => fx.surface}
        pageSize={{ width: 800, height: 600 }}
        markerUv={[0.5, 0.25]}
        onMarkerTap={onMarkerTap}
      />,
    );
    fx.fireReady();

    fireEvent.click(await screen.findByLabelText("Add task here"));
    expect(onMarkerTap).toHaveBeenCalledTimes(1);
  });

  it("re-positions when the marker uv changes (the 'moved' transition)", async () => {
    const fx = fakeSurface();
    const { rerender } = render(
      <TapCreateMarker2D
        getSurface={() => fx.surface}
        pageSize={{ width: 800, height: 600 }}
        markerUv={[0.1, 0.1]}
        onMarkerTap={vi.fn()}
      />,
    );
    fx.fireReady();
    const first = await screen.findByLabelText("Add task here");
    expect(first.style.left).toBe("80px");

    rerender(
      <TapCreateMarker2D
        getSurface={() => fx.surface}
        pageSize={{ width: 800, height: 600 }}
        markerUv={[0.6, 0.4]}
        onMarkerTap={vi.fn()}
      />,
    );
    await waitFor(() => {
      const m = screen.getByLabelText("Add task here");
      expect(m.style.left).toBe("480px");
      expect(m.style.top).toBe("240px");
    });
  });
});