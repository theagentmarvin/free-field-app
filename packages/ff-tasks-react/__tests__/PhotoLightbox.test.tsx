// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PhotoLightbox } from "../src/PhotoLightbox";

afterEach(cleanup);

describe("PhotoLightbox", () => {
  it("navigates a gallery with buttons and arrow keys, wrapping around", () => {
    render(<PhotoLightbox src="b" srcs={["a", "b", "c"]} onClose={() => {}} />);
    const img = () => screen.getByAltText("task photo").getAttribute("src");
    expect(img()).toBe("b");
    fireEvent.click(screen.getByTestId("lightbox-next"));
    expect(img()).toBe("c");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(img()).toBe("a");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(img()).toBe("c");
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });
  it("single photo has no nav; Escape and backdrop close, image click does not", () => {
    const onClose = vi.fn();
    render(<PhotoLightbox src="a" onClose={onClose} />);
    expect(screen.queryByTestId("lightbox-next")).toBeNull();
    fireEvent.click(screen.getByAltText("task photo"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("photo-lightbox"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
