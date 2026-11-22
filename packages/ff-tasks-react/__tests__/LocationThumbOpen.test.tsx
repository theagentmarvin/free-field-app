// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPhotoUrlCache } from "../src/usePhotoUrl";

const open = vi.fn();
vi.mock("../src/taskTarget", async (orig) => ({
  ...(await orig<typeof import("../src/taskTarget")>()),
  useOpenTaskLocation: () => open,
}));

import { LocationThumb, OpenableLocationThumb } from "../src/LocationThumb";

const resolve = async () => "blob:thumb";
const bimTask = {
  id: "t1",
  location: { bim: { elements: [{ modelId: "m1", expressId: 1 }], worldPoint: [0, 0, 0] as [number, number, number] }, pdf: null },
};
const pdfTask = { id: "t2", location: { bim: null, pdf: { pdfFileId: "p1" } } };

afterEach(() => {
  cleanup();
  clearPhotoUrlCache();
  open.mockClear();
});

describe("location thumb quick access", () => {
  it("is a plain image without onOpen", async () => {
    render(<LocationThumb path="a" resolve={resolve} label="Snap" />);
    await screen.findByTestId("ff-location-thumb");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("3D task: button with hand cursor + 'Open in Models' tooltip; click opens it and does not bubble", async () => {
    const parent = vi.fn();
    render(
      <div onClick={parent}>
        <OpenableLocationThumb task={bimTask} path="a" resolve={resolve} label="Snap" />
      </div>,
    );
    const btn = await screen.findByRole("button", { name: "Open in Models" });
    expect(btn.getAttribute("title")).toBe("Open in Models");
    expect(btn.style.cursor).toBe("pointer");
    fireEvent.click(btn);
    expect(open).toHaveBeenCalledWith(bimTask);
    expect(parent).not.toHaveBeenCalled();
  });

  it("plan task: 'Open in Documents'; keyboard Enter opens", async () => {
    render(<OpenableLocationThumb task={pdfTask} path="a" resolve={resolve} label="Snap" />);
    const btn = await screen.findByRole("button", { name: "Open in Documents" });
    fireEvent.keyDown(btn, { key: "Enter" });
    expect(open).toHaveBeenCalledWith(pdfTask);
  });

  it("hover shows the highlight ring", async () => {
    render(<OpenableLocationThumb task={bimTask} path="a" resolve={resolve} label="Snap" />);
    const btn = await screen.findByRole("button");
    expect(btn.style.outline).toContain("transparent");
    fireEvent.mouseEnter(btn);
    expect(btn.style.outline).toContain("#2f6fe4");
  });

  it("a task with no location renders the plain thumb", async () => {
    render(<OpenableLocationThumb task={{ id: "x", location: null }} path="a" resolve={resolve} label="Snap" />);
    await screen.findByTestId("ff-location-thumb");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
