// apps/models/src/taskDetailStore.ts
//
// Wave 52 — module-local store for the task detail sheet id.
//
// Before wave 52 the id lived in <MainAppChrome> React state, which
// was fine while <Viewer> (rendering <TaskDetailHost>) and
// <NavPanel> (with <TasksPanelBody> → onOpenTask) shared the same
// React subtree. Wave 52 moves <TaskDetailHost> into the PERSISTENT
// viewer surface (a separate React tree, portaled into whichever
// route is active). React state can't cross that boundary, so the id
// moves to a tiny module store both trees import — same singleton,
// same session.
//
// Scoped to the Models / Linkview surface task pins + task menu. On
// the Linkview route the task detail sheet still renders inside the
// shared surface (pins are visible there too).

import { create } from "zustand";

interface TaskDetailState {
  detailTaskId: string | null;
  openTask: (taskId: string) => void;
  closeTask: () => void;
}

export const useTaskDetailStore = create<TaskDetailState>((set) => ({
  detailTaskId: null,
  openTask: (taskId) => set({ detailTaskId: taskId }),
  closeTask: () => set({ detailTaskId: null }),
}));