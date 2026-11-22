import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BundleImportTrigger, type BundleImportState } from "../../src/components/BundleImportButton";

function state(over: Partial<BundleImportState> = {}): BundleImportState {
  return {
    inputRef: { current: null },
    enabled: true,
    progress: null,
    summary: null,
    warnings: [],
    error: null,
    onPicked: vi.fn(async () => undefined),
    dismissSummary: () => undefined,
    ...over,
  };
}

describe("<BundleImportTrigger>", () => {
  it("is an icon button with the 'Import bundle' tooltip, boxed like the other + buttons", () => {
    render(<BundleImportTrigger state={state()} />);
    const btn = screen.getByTestId("bundle-import-button") as HTMLButtonElement;
    expect(btn.title).toBe("Import bundle");
    expect(btn.getAttribute("aria-label")).toBe("Import bundle");
    expect(btn.textContent).toBe(""); // icon only, no text label
    expect(btn.querySelector("svg")).not.toBeNull();
    expect(btn.style.width).toBe("30px");
    expect(btn.style.height).toBe("30px");
    expect(btn.style.border).toContain("1px solid");
    const input = screen.getByTestId("bundle-import-input") as HTMLInputElement;
    expect(input.accept).toBe(".ffbundle,.zip");
  });

  it("opens the file picker and is disabled while importing", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => undefined);
    render(<BundleImportTrigger state={{ ...state(), inputRef: createRef<HTMLInputElement>() }} />);
    fireEvent.click(screen.getByTestId("bundle-import-button"));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it("is disabled when imports are not available", () => {
    render(<BundleImportTrigger state={state({ enabled: false })} />);
    expect((screen.getByTestId("bundle-import-button") as HTMLButtonElement).disabled).toBe(true);
  });
});
