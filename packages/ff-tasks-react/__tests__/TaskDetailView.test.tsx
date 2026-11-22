// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import type { TaskEntryView } from "@ff/tasks";
import type { OutboxRecord } from "@ff/types";

import { TaskDetailView, type TaskDetailViewProps } from "../src/TaskDetailView";
import { TaskOutboxSheet } from "../src/TaskOutboxSheet";

/**
 * Chunk 5 seams (plan §7 screens 3–4), updated for the v2 skull: the
 * timeline + comment composer moved into the Activity popup (clock
 * button), so those asserts now open the popup first. Both components
 * remain presentational — prop-fed, no Firebase.
 */

function entry(over: Partial<TaskEntryView> & { clientGuid: string }): TaskEntryView {
  return {
    id: over.clientGuid,
    action: "comment",
    text: "note",
    by: "Sam",
    byUid: "u1",
    at: 1,
    statusFrom: 20,
    statusTo: 20,
    photos: [],
    pending: false,
    failed: false,
    ...over,
  };
}

function viewProps(over: Partial<TaskDetailViewProps> = {}): TaskDetailViewProps {
  return {
    num: 12,
    title: "Set door frame",
    description: "Second fix",
    status: 20,
    assigneeName: "Ada",
    deadline: null,
    location: null,
    entries: [entry({ clientGuid: "c1" })],
    canAct: true,
    onComment: vi.fn(),
    onTransition: vi.fn(),
    onRetryEntry: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

function openActivity(): void {
  fireEvent.click(screen.getByTestId("detail-activity-button"));
}

describe("TaskDetailView", () => {
  it("header: T-number, status band, title", () => {
    render(<TaskDetailView {...viewProps()} />);
    expect(screen.getByText("T012")).toBeTruthy();
    expect(screen.getByTestId("detail-status-band").textContent).toBe("Ongoing");
    expect(screen.getByTestId("detail-title").textContent).toBe("Set door frame");
  });

  it("queued creates (num 0) show the committed-not-yet notice", () => {
    render(<TaskDetailView {...viewProps({ num: 0, title: "Honeycomb edge" })} />);
    expect(screen.getByText(/queued — not committed yet/)).toBeTruthy();
  });

  it("action bar renders only legal transitions for the status", () => {
    render(<TaskDetailView {...viewProps({ status: 40 })} />);
    expect(screen.getByTestId("detail-action-reject")).toBeTruthy();
    expect(screen.getByTestId("detail-action-approve")).toBeTruthy();
    expect(screen.getByTestId("detail-action-followup")).toBeTruthy();
    expect(screen.getByTestId("detail-action-discontinue")).toBeTruthy();
    expect(screen.queryByTestId("detail-action-complete")).toBeNull(); // not legal from 40
  });

  it("ongoing offers complete + discontinue, never reject/approve", () => {
    render(<TaskDetailView {...viewProps()} />);
    expect(screen.getByTestId("detail-action-complete")).toBeTruthy();
    expect(screen.queryByTestId("detail-action-reject")).toBeNull();
    expect(screen.queryByTestId("detail-action-approve")).toBeNull();
  });

  it("terminal tasks get no action bar at all", () => {
    render(<TaskDetailView {...viewProps({ status: 65 })} />);
    expect(screen.queryByTestId("detail-actions")).toBeNull();
  });

  it("canAct=false (demo/offline) hides the bar", () => {
    render(<TaskDetailView {...viewProps({ canAct: false })} />);
    expect(screen.queryByTestId("detail-actions")).toBeNull();
  });

  it("transition click emits the verb", () => {
    const p = viewProps();
    render(<TaskDetailView {...p} />);
    fireEvent.click(screen.getByTestId("detail-action-complete"));
    expect(p.onTransition).toHaveBeenCalledWith("complete");
  });

  it("clock button opens the Activity popup and shows the entry-count badge", () => {
    render(
      <TaskDetailView
        {...viewProps({ entries: [entry({ clientGuid: "a" }), entry({ clientGuid: "b" }), entry({ clientGuid: "c" })] })}
      />
    );
    expect(screen.queryByTestId("activity-popup")).toBeNull();
    expect(screen.getByTestId("detail-activity-count").textContent).toBe("3");
    openActivity();
    expect(screen.getByTestId("activity-popup")).toBeTruthy();
    expect(screen.getByTestId("activity-title").textContent).toContain("T012");
  });

  it("popup composer enqueues a comment through onComment (spy)", () => {
    const p = viewProps();
    render(<TaskDetailView {...p} />);
    openActivity();
    const input = screen.getByTestId("activity-comment-input");
    const send = screen.getByTestId("activity-comment-send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  rebar checked  " } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(p.onComment).toHaveBeenCalledWith("rebar checked");
  });

  it("comment composer trims and clears after send", () => {
    const p = viewProps();
    render(<TaskDetailView {...p} />);
    openActivity();
    fireEvent.change(screen.getByTestId("activity-comment-input"), { target: { value: "  nudge  " } });
    fireEvent.click(screen.getByTestId("activity-comment-send"));
    expect(p.onComment).toHaveBeenCalledWith("nudge");
  });

  it("Escape closes the detail sheet, but only the activity popup when it is open", () => {
    const onClose = vi.fn();
    render(<TaskDetailView {...viewProps({ onClose })} />);
    openActivity();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("activity-popup")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("popup closes on Escape", () => {
    render(<TaskDetailView {...viewProps()} />);
    openActivity();
    expect(screen.getByTestId("activity-popup")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("activity-popup")).toBeNull();
  });

  it("queued entries render ⋯, failed entries offer retry (inside popup)", () => {
    const p = viewProps({
      entries: [
        entry({ clientGuid: "gA", pending: true }),
        entry({ clientGuid: "gB", pending: true, failed: true }),
      ],
    });
    render(<TaskDetailView {...p} />);
    openActivity();
    expect(screen.queryByTestId("entry-retry-gA")).toBeNull();
    fireEvent.click(screen.getByTestId("entry-retry-gB"));
    expect(p.onRetryEntry).toHaveBeenCalledWith("gB");
  });

  it("location card is the control — click invokes the locate callback", () => {
    const bim = {
      elements: [{ modelId: "m1", expressId: 7 }],
      worldPoint: [1, 2, 3] as [number, number, number],
      cameraPose: { pos: [0, 0, 5] as [number, number, number], target: [1, 2, 3] as [number, number, number], fov: 45, isOrtho: false },
    };
    const location = { storeyName: "L1", bim, pdf: { pdfFileId: "f1", page: 2, uv: [0.5, 0.5] as [number, number], calibId: "k1" } };

    const p = viewProps({ location, onShowIn3D: vi.fn(), onShowOnPlan: vi.fn() });
    render(<TaskDetailView {...p} />);
    const card = screen.getByTestId("detail-location-card");
    expect(card.tagName).toBe("BUTTON"); // clickable because a viewer callback exists
    fireEvent.click(card);
    expect(p.onShowIn3D).toHaveBeenCalledWith(bim); // 3D pin is primary
  });

  it("location card shows an Open in Models / Documents affordance", () => {
    const bim = { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null };
    const { unmount } = render(<TaskDetailView {...viewProps({ location: { storeyName: "L1", bim, pdf: null }, onShowIn3D: vi.fn() })} />);
    expect(screen.getByTestId("detail-location-open-label").textContent).toContain("Open in Models");
    expect(screen.getByTestId("detail-location-card").getAttribute("title")).toBe("Open in Models");
    unmount();
    const pdf = { pdfFileId: "f1", page: 2, uv: [0.5, 0.5] as [number, number], calibId: "k1" };
    render(<TaskDetailView {...viewProps({ location: { storeyName: "L1", bim: null, pdf }, onShowOnPlan: vi.fn() })} />);
    expect(screen.getByTestId("detail-location-open-label").textContent).toContain("Open in Documents");
  });

  it("location card is non-interactive without a host callback", () => {
    const location = {
      storeyName: "L2",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskDetailView {...viewProps({ location })} />);
    const card = screen.getByTestId("detail-location-card");
    expect(card.tagName).toBe("DIV"); // no onShowIn3D → not a button
  });

  it("hide-instance button renders with a bim pin + callback and invokes onHideInstance(bim)", () => {
    const bim = {
      elements: [{ modelId: "m1", expressId: 7 }],
      worldPoint: [1, 2, 3] as [number, number, number],
      cameraPose: null,
    };
    const location = { storeyName: "L1", bim, pdf: null };
    const onHideInstance = vi.fn();
    render(<TaskDetailView {...viewProps({ location, onHideInstance })} />);

    const btn = screen.getByTestId("task-detail-hide-instance");
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(onHideInstance).toHaveBeenCalledWith(bim);
  });

  it("hide-instance button is absent without a callback", () => {
    const location = {
      storeyName: "L1",
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskDetailView {...viewProps({ location })} />);
    expect(screen.queryByTestId("task-detail-hide-instance")).toBeNull();
  });

  it("hide-instance button is absent without a bim pin", () => {
    const location = {
      storeyName: "L1",
      bim: null,
      pdf: { pdfFileId: "f1", page: 2, uv: [0.5, 0.5] as [number, number], calibId: "k1" },
    };
    render(<TaskDetailView {...viewProps({ location, onHideInstance: vi.fn() })} />);
    expect(screen.queryByTestId("task-detail-hide-instance")).toBeNull();
  });

  it("empty location state shows guidance, no button", () => {
    render(<TaskDetailView {...viewProps({ location: null })} />);
    expect(screen.getByTestId("detail-location-empty")).toBeTruthy();
    expect(screen.queryByTestId("detail-location-card")).toBeNull();
  });

  it("renders the location snapshot thumb through the resolver (Day-3)", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    const location = {
      storeyName: "L1",
      thumb: { storagePath: "projects/p1/tasks/t1/location-thumb.jpg" },
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskDetailView {...viewProps({ location, resolvePhotoUrl: resolve })} />);
    const img = await screen.findByTestId("detail-location-thumb");
    expect(img.getAttribute("src")).toBe("https://files.test/projects/p1/tasks/t1/location-thumb.jpg");
  });

  it("falls back to the placeholder when the thumb cannot resolve", async () => {
    const resolve = vi.fn(async () => null);
    const location = {
      storeyName: "L1",
      thumb: { storagePath: "projects/p1/tasks/t1/location-thumb.jpg" },
      bim: { elements: [{ modelId: "m1", expressId: 7 }], worldPoint: [1, 2, 3] as [number, number, number], cameraPose: null },
      pdf: null,
    };
    render(<TaskDetailView {...viewProps({ location, resolvePhotoUrl: resolve })} />);
    expect(screen.getByTestId("detail-location-card")).toBeTruthy();
    expect(screen.queryByTestId("detail-location-thumb")).toBeNull();
  });

  const photo = (path: string) => ({
    storagePath: path,
    sha256: "0".repeat(64),
    size: 1,
    mime: "image/jpeg",
  });

  it("assign picker appears where the machine allows assign and fires the verb (VDC Bug 4)", () => {
    const onAssign = vi.fn();
    render(
      <TaskDetailView
        {...viewProps({ status: 10, assigneeName: null, onAssign, people: [{ uid: "u9", name: "Bob" }] })}
      />
    );
    fireEvent.change(screen.getByTestId("detail-assign"), { target: { value: "u9" } });
    expect(onAssign).toHaveBeenCalledWith("u9", "Bob");
  });

  it("assign picker re-labels when already assigned", () => {
    render(
      <TaskDetailView {...viewProps({ onAssign: vi.fn(), people: [{ uid: "u9", name: "Bob" }] })} />
    );
    expect(screen.getByTestId("detail-assign").textContent).toContain("Re-assign (now Ada)");
  });

  it("assign picker hides where the verb is illegal", () => {
    render(
      <TaskDetailView
        {...viewProps({ status: 40, onAssign: vi.fn(), people: [{ uid: "u9", name: "Bob" }] })}
      />
    );
    expect(screen.queryByTestId("detail-assign")).toBeNull(); // awaiting: assign illegal
  });

  it("assign picker hides without a roster (list hosts, fetch pending)", () => {
    render(<TaskDetailView {...viewProps({ onAssign: vi.fn() })} />);
    expect(screen.queryByTestId("detail-assign")).toBeNull();
  });

  it("resolved entry photos render as tappable thumbnails with a lightbox (VDC Bug 3)", () => {
    render(
      <TaskDetailView
        {...viewProps({
          entries: [entry({ clientGuid: "cp1", photos: [photo("s1"), photo("s2")] })],
          photoUrls: { s1: "https://x/s1.jpg" },
        })}
      />
    );
    openActivity();
    const thumbs = screen.getAllByTestId("entry-photo-thumb");
    expect(thumbs).toHaveLength(1); // only the resolved path became an image
    expect(thumbs[0]!.querySelector("img")?.getAttribute("src")).toBe("https://x/s1.jpg");
    fireEvent.click(thumbs[0]!);
    const box = screen.getByTestId("photo-lightbox");
    expect(box.querySelector("img")?.getAttribute("src")).toBe("https://x/s1.jpg");
    fireEvent.click(box);
    expect(screen.queryByTestId("photo-lightbox")).toBeNull();
  });

  it("unresolved entry photos keep the 📷 chip fallback (demo/offline)", () => {
    render(
      <TaskDetailView
        {...viewProps({
          entries: [entry({ clientGuid: "cp2", photos: [photo("s1"), photo("s2")] })],
        })}
      />
    );
    openActivity();
    expect(screen.queryAllByTestId("entry-photo-thumb")).toHaveLength(0);
    const row = screen.getByTestId("entry-cp2");
    expect(row.textContent).toContain("📷");
  });

  it("task-level attachments render as a grid with lightbox", () => {
    render(
      <TaskDetailView
        {...viewProps({
          photos: [photo("t1"), photo("t2")],
          photoUrls: { t1: "https://x/t1.jpg" },
          entries: [],
        })}
      />
    );
    expect(screen.getByText(/Attachments · 2\/10/)).toBeTruthy();
    expect(screen.getAllByTestId("detail-photo-thumb")).toHaveLength(1); // only resolved
    fireEvent.click(screen.getByTestId("detail-photo-thumb"));
    expect(screen.getByTestId("photo-lightbox")).toBeTruthy();
  });
});

describe("TaskDetailView — wave 53 floating-card shell", () => {
  it("renders as a desktop floating card over a scrim", () => {
    render(<TaskDetailView {...viewProps()} />);
    expect(screen.getByTestId("task-sheet-scrim")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Task detail" })).toBeTruthy();
  });

  it("backdrop click closes the sheet", () => {
    const onClose = vi.fn();
    render(<TaskDetailView {...viewProps({ onClose })} />);
    fireEvent.click(screen.getByTestId("task-sheet-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("TaskOutboxSheet", () => {
  const row = (over: Partial<OutboxRecord> & { id: string }): OutboxRecord => ({
    kind: "task-action",
    state: "added",
    projectId: "p1",
    payload: { verb: "comment", title: "Set door frame", taskId: "t1" },
    photoRefs: [],
    attempts: 0,
    clientGuid: over.id,
    createdAt: 1,
    ...over,
  });

  it("lists live rows only, sorted; wired retry/delete", () => {
    const rows = [
      row({ id: "r2", state: "sent" }),
      row({ id: "r3", state: "failed", attempts: 3, lastError: "permission-denied" }),
      row({ id: "r1", state: "added", createdAt: 0 }),
      row({ id: "r4", state: "killed" }),
    ];
    const onRetry = vi.fn();
    const onDelete = vi.fn();
    render(<TaskOutboxSheet rows={rows} onRetry={onRetry} onDelete={onDelete} onClose={vi.fn()} />);

    expect(screen.getByText("Outbox (2)")).toBeTruthy(); // r1 + r3 (r1 earlier by createdAt)
    expect(screen.queryByTestId("outbox-row-r2")).toBeNull();
    expect(screen.queryByTestId("outbox-row-r4")).toBeNull();
    expect(screen.getByText("permission-denied")).toBeTruthy();

    fireEvent.click(screen.getByTestId("outbox-retry-r3"));
    fireEvent.click(screen.getByTestId("outbox-delete-r1"));
    expect(onRetry).toHaveBeenCalledWith("r3");
    expect(onDelete).toHaveBeenCalledWith("r1");
    // added rows have no retry affordance — only failed ones do
    expect(screen.queryByTestId("outbox-retry-r1")).toBeNull();
  });

  it("empty state message", () => {
    render(<TaskOutboxSheet rows={[]} onRetry={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("outbox-empty")).toBeTruthy();
  });
});