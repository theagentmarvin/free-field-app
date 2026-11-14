// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnchoredPopover, computePopoverGeometry } from "../src/AnchoredPopover";
import { TaskToolbar } from "../src/TaskToolbar";
import { TaskColumnPicker } from "../src/TaskColumnPicker";

afterEach(cleanup);

const A = (top: number, left: number, w = 80, h = 30) => ({ top, bottom: top + h, left, right: left + w });

describe("computePopoverGeometry", () => {
  it("places below, right-aligned, when there is room", () => {
    const g = computePopoverGeometry(A(100, 500), { width: 260, height: 300 }, 1200, 800, "end", 4);
    expect(g.placement).toBe("below");
    expect(g.top).toBe(134);
    expect(g.left).toBe(580 - 260);
  });
  it("flips above near the bottom edge", () => {
    const g = computePopoverGeometry(A(700, 500), { width: 260, height: 300 }, 1200, 800, "end", 4);
    expect(g.placement).toBe("above");
    expect(g.top + 300).toBeLessThanOrEqual(700);
  });
  it("clamps horizontally and caps height with internal scroll", () => {
    const g = computePopoverGeometry(A(10, 1180), { width: 260, height: 2000 }, 1200, 800, "start", 4);
    expect(g.left + 260).toBeLessThanOrEqual(1200 - 8);
    expect(g.maxHeight).toBeLessThanOrEqual(800);
    expect(g.top).toBeGreaterThanOrEqual(8);
    const g2 = computePopoverGeometry(A(10, -50), { width: 260, height: 100 }, 1200, 800, "end", 4);
    expect(g2.left).toBeGreaterThanOrEqual(8);
  });
});

function Host({ onClose }: { onClose: () => void }): JSX.Element {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div style={{ overflow: "hidden", height: 10 }} data-testid="clipper">
      <button ref={setEl}>trigger</button>
      <AnchoredPopover anchor={el} open onClose={onClose} ariaLabel="Pop" data-testid="pop">
        <div>content</div>
      </AnchoredPopover>
    </div>
  );
}

describe("AnchoredPopover", () => {
  it("portals to document.body, outside any overflow-clipping ancestor", () => {
    render(<Host onClose={() => {}} />);
    const pop = screen.getByTestId("pop");
    expect(pop.parentElement).toBe(document.body);
    expect(screen.getByTestId("clipper").contains(pop)).toBe(false);
    expect(pop.style.position).toBe("fixed");
    expect(pop.style.overflowY).toBe("auto");
  });
  it("closes on outside mousedown, not on inside mousedown", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("content"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("closes on Escape and returns focus to the anchor", () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByText("trigger"));
  });
  it("re-measures on scroll and resize", () => {
    render(<Host onClose={() => {}} />);
    const trigger = screen.getByText("trigger");
    let top = 50;
    trigger.getBoundingClientRect = () => ({ top, bottom: top + 20, left: 100, right: 180, width: 80, height: 20, x: 100, y: top, toJSON() {} }) as DOMRect;
    fireEvent.scroll(document.body);
    expect(screen.getByTestId("pop").style.top).toBe("74px");
    top = 200;
    fireEvent(window, new Event("resize"));
    expect(screen.getByTestId("pop").style.top).toBe("224px");
  });
});

describe("Columns picker in toolbar", () => {
  it("renders in a portal, not inside the scrolling actions row", () => {
    render(
      <TaskToolbar
        chip="all"
        onChipChange={() => {}}
        search=""
        onSearchChange={() => {}}
        sort="updated"
        onSortChange={() => {}}
        queued={0}
        onOpenOutbox={() => {}}
        canCreate
        onCreate={() => {}}
        singleRow
        showColumnTools
        activeFilterCount={0}
        onClearFilters={() => {}}
        columnsOpen
        onToggleColumns={() => {}}
        columnsPicker={(anchor) => (
          <TaskColumnPicker anchor={anchor} visible={new Set(["num", "title"]) as never} onCommit={() => {}} onCancel={() => {}} />
        )}
      />
    );
    const picker = screen.getByTestId("ff-task-columns-picker");
    expect(picker.closest(".ff-task-actions")).toBeNull();
    expect(picker.closest("header")).toBeNull();
    expect(screen.getByTestId("ff-task-columns-popover").parentElement).toBe(document.body);
  });
});
