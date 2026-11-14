// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { type DraftTable, type OutboxEngine } from "@ff/tasks";

import { TaskComposeSheet, type TaskComposeSheetProps } from "../src/TaskComposeSheet";

/**
 * Compose sheet seams (v2). Presentational + prop-fed (no Firebase,
 * no real outbox). Pins the six zones, the disabled-until-title send
 * gate + hint, and the assign-to-me quick chip.
 */

function engineMock(): OutboxEngine {
  return {
    enqueue: vi.fn().mockResolvedValue({ id: "row" }),
    drain: vi.fn(),
    retryNow: vi.fn(),
    remove: vi.fn(),
  } as unknown as OutboxEngine;
}

function draftTableMock(): DraftTable {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    whereProject: vi.fn().mockResolvedValue([]),
  } as unknown as DraftTable;
}

function props(over: Partial<TaskComposeSheetProps> = {}): TaskComposeSheetProps {
  return {
    projectId: "p1",
    taskId: "t1",
    actor: { uid: "u-me", name: "Alex Rivera" },
    members: [{ uid: "u9", name: "Bob" }],
    engine: engineMock(),
    draftTable: draftTableMock(),
    onDone: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

describe("TaskComposeSheet", () => {
  it("renders the six zones + sticky bottom", () => {
    render(<TaskComposeSheet {...props()} />);
    expect(screen.getByTestId("compose-zone-topbar")).toBeTruthy();
    expect(screen.getByTestId("compose-zone-taskdata")).toBeTruthy();
    expect(screen.getByTestId("compose-zone-location")).toBeTruthy();
    expect(screen.getByTestId("compose-zone-fields")).toBeTruthy();
    expect(screen.getByTestId("compose-zone-attachments")).toBeTruthy();
    expect(screen.getByTestId("compose-zone-bottom")).toBeTruthy();
  });

  it("Send is disabled without a title and shows the inline hint", () => {
    render(<TaskComposeSheet {...props()} />);
    const send = screen.getByTestId("compose-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(screen.getByTestId("compose-send-hint").textContent).toBe("Add a title first");
  });

  it("Send enables once the title is non-empty", () => {
    render(<TaskComposeSheet {...props()} />);
    fireEvent.change(screen.getByTestId("compose-title"), { target: { value: "Fix lintel" } });
    expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("assign-to-me sets the assignee to the actor", () => {
    render(
      <TaskComposeSheet
        {...props({ members: [{ uid: "u-me", name: "Alex Rivera" }, { uid: "u9", name: "Bob" }] })}
      />
    );
    fireEvent.click(screen.getByTestId("compose-assign-me"));
    const select = screen.getByTestId("compose-assignee") as HTMLSelectElement;
    expect(select.value).toBe("u-me");
  });

  it("type chips single-select; legacy custom type renders as a selected chip", () => {
    render(<TaskComposeSheet {...props({ initial: { type: "observation" } })} />);
    // legacy free-text value → custom selected chip
    const custom = screen.getByTestId("compose-type-custom") as HTMLButtonElement;
    expect(custom.getAttribute("aria-checked")).toBe("true");
    // selecting a standard chip replaces the custom value
    fireEvent.click(screen.getByTestId("compose-type-RFI"));
    expect(screen.queryByTestId("compose-type-custom")).toBeNull();
    expect(screen.getByTestId("compose-type-RFI").getAttribute("aria-checked")).toBe("true");
  });

  it("empty location state renders the dashed guidance card", () => {
    render(<TaskComposeSheet {...props({ location: null })} />);
    expect(screen.getByTestId("compose-location-empty")).toBeTruthy();
  });

  it("pinned location renders a badge + clear affordance that removes it", () => {
    const location = {
      storeyName: "L1",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskComposeSheet {...props({ location })} />);
    expect(screen.getByText("3D", { exact: true })).toBeTruthy();
    fireEvent.click(screen.getByTestId("compose-location-clear"));
    expect(screen.getByTestId("compose-location-empty")).toBeTruthy();
  });

  it("shows the location snapshot thumb from its object URL (Day-3)", () => {
    const location = {
      storeyName: "L1",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(
      <TaskComposeSheet
        {...props({
          location,
          locationThumb: { blobKey: "b1", size: 3, mime: "image/jpeg", previewUrl: "blob:thumb-preview" },
        })}
      />
    );
    const img = screen.getByTestId("compose-location-thumb") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:thumb-preview");
  });

  it("pinned location without a snapshot falls back to the placeholder icon", () => {
    const location = {
      storeyName: "L1",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskComposeSheet {...props({ location })} />);
    expect(screen.queryByTestId("compose-location-thumb")).toBeNull();
  });
});

describe("TaskComposeSheet — wave 53 floating-card shell", () => {
  afterEach(() => {
    Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  });

  it("renders as a desktop floating card over a scrim", () => {
    render(<TaskComposeSheet {...props()} />);
    expect(screen.getByTestId("task-sheet-scrim")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "New task" })).toBeTruthy();
  });

  it("backdrop click closes the sheet", () => {
    const onClose = vi.fn();
    render(<TaskComposeSheet {...props({ onClose })} />);
    fireEvent.click(screen.getByTestId("task-sheet-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the amber offline banner when offline", () => {
    Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
    render(<TaskComposeSheet {...props()} />);
    expect(screen.getByTestId("compose-offline-strip")).toBeTruthy();
    expect(screen.getByText(/Offline — changes queue automatically/)).toBeTruthy();
  });
});
describe("TaskComposeSheet — snapshot object URL lifecycle (w68)", () => {
  const loc = { pdf: { pdfFileId: "f", page: 1, uv: [0.5, 0.5], calibId: "c" } } as never;
  const thumb = { blobKey: "bk", size: 3, mime: "image/jpeg", previewUrl: "blob:preview" };

  it("StrictMode's simulated remount does not revoke the preview URL; a real unmount does", async () => {
    await new Promise((r) => setTimeout(r, 10)); // drain earlier tests' deferred cleanups
    const revoke = vi.fn();
    const orig = URL.revokeObjectURL;
    URL.revokeObjectURL = revoke;
    try {
      const { StrictMode } = await import("react");
      const { unmount } = render(
        <StrictMode>
          <TaskComposeSheet {...props({ location: loc, locationThumb: thumb })} />
        </StrictMode>
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(revoke).not.toHaveBeenCalled();
      unmount();
      await new Promise((r) => setTimeout(r, 10));
      expect(revoke).toHaveBeenCalledWith("blob:preview");
    } finally {
      URL.revokeObjectURL = orig;
    }
  });
});
