// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { create } from "zustand";

import { requestTaskOpen, resetTaskOpenStore, setTaskOpenNotice } from "@ff/tasks-react";

// The viewer-tools barrel pulls the WebGL stack; the bridge only needs
// the shared building store.
vi.mock("@ff/viewer-tools", () => {
  const useModelsToolStore = create<{ activeBuildingId: string | null; setActiveBuildingId: (id: string | null) => void }>((set) => ({
    activeBuildingId: "bA",
    setActiveBuildingId: (id) => set({ activeBuildingId: id }),
  }));
  return { useModelsToolStore };
});

import { useModelsToolStore } from "@ff/viewer-tools";
import { TaskOpenBridge } from "../../src/shell/TaskOpenBridge";

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function mount(path = "/tasks") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TaskOpenBridge />
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TaskOpenBridge", () => {
  beforeEach(() => {
    resetTaskOpenStore();
    useModelsToolStore.setState({ activeBuildingId: "bA" });
  });
  afterEach(cleanup);

  it("routes a 3D intent to /models", () => {
    mount();
    act(() => {
      requestTaskOpen({ kind: "models", taskId: "t", buildingId: "bA", elements: [], worldPoint: null, cameraPose: null });
    });
    expect(screen.getByTestId("where").textContent).toBe("/models");
  });

  it("switches building first, then routes a plan intent to /documents", () => {
    mount();
    act(() => {
      requestTaskOpen({ kind: "documents", taskId: "t", buildingId: "bB", pdfFileId: "p", versionId: "v", page: 1, uv: null });
    });
    expect(useModelsToolStore.getState().activeBuildingId).toBe("bB");
    expect(screen.getByTestId("where").textContent).toBe("/documents");
  });

  it("switches building first, then routes a LinkView task to /linkview", () => {
    mount();
    act(() => {
      requestTaskOpen({ kind: "linkview", taskId: "t", buildingId: "bB", documents: null, models: null });
    });
    expect(useModelsToolStore.getState().activeBuildingId).toBe("bB");
    expect(screen.getByTestId("where").textContent).toBe("/linkview");
  });

  it("shows the notice (target missing / superseded version)", () => {
    mount();
    act(() => {
      setTaskOpenNotice("The plan sheet this task was pinned on no longer exists.");
    });
    expect(screen.getByTestId("task-open-notice").textContent).toContain("no longer exists");
  });
});
