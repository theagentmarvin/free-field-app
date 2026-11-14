// __tests__/hooks/useFloorPlanOverlay.test.tsx
//
// Wave 63 — overlay opacity API of useFloorPlanOverlay:
//   - the plane is placed with the caller's opacity (default 1, not
//     the old hard-coded dim 0.40)
//   - an opacity change updates the existing plane LIVE via
//     setFloorPlanPlaneOpacity + requestRender, without re-loading the
//     PDF or re-creating the plane/texture.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

const loadPDF = vi.hoisted(() => vi.fn());

vi.mock("@ff/viewer", () => ({ loadPDF }));
vi.mock("@ff/data/db/tables/pdfVersions", () => ({
  getPdfVersion: vi.fn(async () => ({ id: "v1", blobKey: "b1" })),
}));
vi.mock("@ff/data/db/tables/pdfBlobs", () => ({
  getPdfBlob: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])])),
}));
vi.mock("@ff/data/calibration/similarity", () => ({
  applyCalibration: (_p: unknown, pt: { x: number; y: number }) => ({ x: pt.x, z: pt.y }),
}));

import { useFloorPlanOverlay } from "../../src/hooks/useFloorPlanOverlay";

const CAL = {
  transformParams: { scale: 1, rotation: 0, tx: 0, ty: 0 } as never,
  floorZ: 3,
};

function makeHandle() {
  return {
    addFloorPlanPlane: vi.fn(() => "plane-1"),
    removeFloorPlanPlane: vi.fn(),
    setFloorPlanPlaneOpacity: vi.fn(),
    requestRender: vi.fn(),
  };
}

function Harness({
  handle,
  opacity,
}: {
  handle: ReturnType<typeof makeHandle>;
  opacity?: number;
}): null {
  const ref = useRef<IfcViewerHandle>(handle as unknown as IfcViewerHandle);
  ref.current = handle as unknown as IfcViewerHandle;
  useFloorPlanOverlay(ref, "v1", CAL, true, opacity);
  return null;
}

beforeEach(() => {
  loadPDF.mockReset();
  loadPDF.mockImplementation(async () => ({
    width: 100,
    height: 50,
    renderPage: async () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    destroy: vi.fn(),
  }));
});

describe("useFloorPlanOverlay — opacity (wave 63)", () => {
  it("places the plane fully opaque by default", async () => {
    const handle = makeHandle();
    render(<Harness handle={handle} />);
    await waitFor(() => expect(handle.addFloorPlanPlane).toHaveBeenCalledTimes(1));
    const call = handle.addFloorPlanPlane.mock.calls[0] as unknown[];
    expect(call[3]).toEqual({ opacity: 1 });
  });

  it("places the plane with the caller's opacity", async () => {
    const handle = makeHandle();
    render(<Harness handle={handle} opacity={0.85} />);
    await waitFor(() => expect(handle.addFloorPlanPlane).toHaveBeenCalledTimes(1));
    expect((handle.addFloorPlanPlane.mock.calls[0] as unknown[])[3]).toEqual({ opacity: 0.85 });
  });

  it("updates the existing plane live without reloading the PDF", async () => {
    const handle = makeHandle();
    const { rerender } = render(<Harness handle={handle} opacity={0.85} />);
    await waitFor(() => expect(handle.addFloorPlanPlane).toHaveBeenCalledTimes(1));
    handle.setFloorPlanPlaneOpacity.mockClear();
    handle.requestRender.mockClear();

    rerender(<Harness handle={handle} opacity={0.5} />);

    expect(handle.setFloorPlanPlaneOpacity).toHaveBeenCalledWith("plane-1", 0.5);
    expect(handle.requestRender).toHaveBeenCalled();
    // No new texture / plane, no PDF re-render.
    expect(handle.addFloorPlanPlane).toHaveBeenCalledTimes(1);
    expect(handle.removeFloorPlanPlane).not.toHaveBeenCalled();
    expect(loadPDF).toHaveBeenCalledTimes(1);
  });

  it("an opacity change before the plane exists is applied at placement", async () => {
    let release!: () => void;
    loadPDF.mockImplementation(
      () =>
        new Promise((res) => {
          release = () =>
            res({
              width: 100,
              height: 50,
              renderPage: async () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
              destroy: vi.fn(),
            });
        }),
    );
    const handle = makeHandle();
    const { rerender } = render(<Harness handle={handle} opacity={0.85} />);
    await waitFor(() => expect(loadPDF).toHaveBeenCalled());
    rerender(<Harness handle={handle} opacity={0.3} />);
    expect(handle.setFloorPlanPlaneOpacity).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(handle.addFloorPlanPlane).toHaveBeenCalledTimes(1));
    expect((handle.addFloorPlanPlane.mock.calls[0] as unknown[])[3]).toEqual({ opacity: 0.3 });
  });
});
