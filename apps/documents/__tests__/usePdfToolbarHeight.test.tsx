// The Documents toolbar offset follows the open PDF's own tool row.
import { describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";

import { usePdfToolbarHeight } from "../src/hooks/usePdfToolbarHeight";

function Probe({ enabled }: { enabled: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const h = usePdfToolbarHeight(ref, enabled);
  return (
    <div ref={ref}>
      <span data-testid="h">{h}</span>
      <div data-testid="mount" />
    </div>
  );
}

function addToolbar(height: number): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "pv-toolbar";
  bar.getBoundingClientRect = () => ({ height } as DOMRect);
  screen.getByTestId("mount").appendChild(bar);
  return bar;
}

describe("usePdfToolbarHeight", () => {
  it("is 0 when no PDF is open", () => {
    render(<Probe enabled={false} />);
    expect(screen.getByTestId("h").textContent).toBe("0");
  });

  it("picks up the PDF tool row once it mounts (async after load)", async () => {
    render(<Probe enabled />);
    expect(screen.getByTestId("h").textContent).toBe("0");
    await act(async () => {
      addToolbar(43);
      await Promise.resolve();
    });
    expect(screen.getByTestId("h").textContent).toBe("43");
  });

  it("drops back to 0 when the PDF closes", async () => {
    const { rerender } = render(<Probe enabled />);
    await act(async () => {
      addToolbar(43);
      await Promise.resolve();
    });
    rerender(<Probe enabled={false} />);
    expect(screen.getByTestId("h").textContent).toBe("0");
  });
});
