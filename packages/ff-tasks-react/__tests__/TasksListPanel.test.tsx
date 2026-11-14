// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import type { TaskView } from "@ff/tasks";

import { TasksListPanel } from "../src/TasksListPanel";
import { clearPhotoUrlCache } from "../src/usePhotoUrl";

/**
 * Wave 1A · list-row photo thumb (VDC 2026-11-02).
 *
 * The panel stays Firebase-free: the host hands in a plain
 * `resolvePhotoUrl` promise function, the panel renders the FIRST
 * photo of a row as a 24px thumb between the T-number and the title.
 * A failed/unresolved photo renders NOTHING (no broken image, no
 * error badge) and an absent resolver leaves the DOM exactly as it
 * was before the feature.
 */

function row(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    num: 1,
    title: "Crack in slab",
    status: 20,
    updatedAt: 100,
    assigneeName: "Ana",
    lastAction: "create",
    entryCount: 1,
    ...over,
  };
}

beforeEach(() => {
  clearPhotoUrlCache();
});

describe("TasksListPanel — photo thumb", () => {
  it("renders the first photo as a thumb when the resolver resolves", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    render(
      <TasksListPanel
        rows={[row({ photos: [{ storagePath: "projects/p1/tasks/t1/a-0.jpg" }] })]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    const thumb = await screen.findByTestId("ff-task-thumb");
    expect(thumb.getAttribute("src")).toBe("https://files.test/projects/p1/tasks/t1/a-0.jpg");
    expect(thumb.getAttribute("width")).toBe("24");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("renders only the FIRST photo of a row", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    render(
      <TasksListPanel
        rows={[
          row({
            photos: [
              { storagePath: "p/first.jpg" },
              { storagePath: "p/second.jpg" },
            ],
          }),
        ]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    await screen.findByTestId("ff-task-thumb");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("p/first.jpg");
  });

  it("the thumb sits between the T-number and the title", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    const { container } = render(
      <TasksListPanel
        rows={[row({ photos: [{ storagePath: "p/a.jpg" }] })]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    await screen.findByTestId("ff-task-thumb");
    const li = container.querySelector("li") as HTMLElement;
    const children = [...li.children];
    const numIdx = children.findIndex((el) => el.textContent?.includes("T001"));
    const thumbIdx = children.findIndex((el) => el.tagName === "IMG");
    const titleIdx = children.findIndex((el) => el.textContent?.includes("Crack in slab"));
    expect(numIdx).toBeGreaterThanOrEqual(0);
    expect(thumbIdx).toBe(numIdx + 1);
    expect(titleIdx).toBe(thumbIdx + 1);
  });

  it("the shared cache dedupes repeated paths across rows", async () => {
    const resolve = vi.fn(async (p: string) => `https://files.test/${p}`);
    render(
      <TasksListPanel
        rows={[
          row({ id: "a", photos: [{ storagePath: "p/same.jpg" }] }),
          row({ id: "b", photos: [{ storagePath: "p/same.jpg" }] }),
          row({ id: "c", photos: [{ storagePath: "p/same.jpg" }] }),
        ]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    await waitFor(() => expect(screen.getAllByTestId("ff-task-thumb")).toHaveLength(3));
    expect(resolve).toHaveBeenCalledTimes(1); // ONE network call for three rows
  });

  it("a rejected resolver renders no thumb and never crashes the row", async () => {
    const resolve = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    render(
      <TasksListPanel
        rows={[row({ photos: [{ storagePath: "p/gone.jpg" }] })]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    await waitFor(() => expect(resolve).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("ff-task-thumb")).toBeNull());
    expect(screen.getByText("Crack in slab")).toBeTruthy(); // the row still renders
  });

  it("a resolver returning null renders no thumb", async () => {
    const resolve = vi.fn(async () => null);
    render(
      <TasksListPanel
        rows={[row({ photos: [{ storagePath: "p/none.jpg" }] })]}
        now={0}
        resolvePhotoUrl={resolve}
      />
    );

    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByTestId("ff-task-thumb")).toBeNull();
  });

  it("WITHOUT the resolver prop the DOM is unchanged — no thumb at all", async () => {
    const { container } = render(
      <TasksListPanel rows={[row({ photos: [{ storagePath: "p/a.jpg" }] })]} now={0} />
    );

    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(screen.queryByTestId("ff-task-thumb")).toBeNull();
    expect(screen.getByText("T001")).toBeTruthy();
    expect(screen.getByText("Crack in slab")).toBeTruthy();
  });
});
