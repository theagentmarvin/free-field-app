import { useEffect, useState } from "react";

import { requireProjectId, useProjectId } from "@ff/auth";
import type { TaskLocation } from "@ff/firestore";

import type { CalloutHandle } from "./callouts";
import { draftTable, useTaskEngine } from "./useTaskEngine";
import { useTaskPeople } from "./useTaskPeople";
import { useTasksFirestore } from "./tasksSource";
import { TaskComposeSheet } from "./TaskComposeSheet";
import { TapCreateMarker3D } from "./TapCreateMarker3D";
import { attachSnapshotThumb } from "./snapshot";
import type { ComposeLocationThumb } from "./composeModel";

/**
 * "Tasks are created by tapping the model" (Wave 5B) — the 3D half of
 * the tap-to-create entry point. Replaces the removed PinTaskButton's
 * toolbar affordance with the floating + marker; the compose→outbox
 * pipeline it feeds is unchanged (this host reuses the exact compose
 * sheet + engine/people wiring the old pin button had).
 *
 * The marker renders the + button; a tap builds the SAME
 * `TaskLocation(bim: {elements, worldPoint, cameraPose})` shape the
 * pin flow produced (worldPoint is the REAL click point when the
 * selection came from a canvas pick — wave 20 — else the selection
 * bbox centre) and opens the compose sheet with it
 * prefilled. Zero viewer-package imports — the handle is consumed
 * through `CalloutHandle`.
 */

export interface TapCreateTask3DProps {
  getHandle: () => CalloutHandle | null;
  /** active storey name from the host's tool store (may be null) */
  storeyName?: string | null;
  /** Wave 53 — the host closes its own task detail sheet when compose
   *  opens (compose/detail mutual exclusion on the viewer path). */
  onComposeOpen?: () => void;
  /** Wave 53 — when a task detail opens (id becomes non-null), give way
   *  to it by closing the compose sheet. */
  detailTaskId?: string | null;
}

interface PendingPin {
  taskId: string;
  location: TaskLocation;
  locationThumb: ComposeLocationThumb | null;
}

export function TapCreateTask3D({
  getHandle,
  storeyName = null,
  onComposeOpen,
  detailTaskId = null,
}: TapCreateTask3DProps): JSX.Element | null {
  const engine = useTaskEngine();
  const projectId = useProjectId();
  const db = useTasksFirestore();
  const { actor, members, ensureMembers } = useTaskPeople(db, projectId);

  const [pending, setPending] = useState<PendingPin | null>(null);

  // Wave 53 — opening a task detail (pin tap / task menu) surrenders
  // the compose sheet: one seam, the same mutual exclusion the /tasks
  // module enforces between its `compose` and `detailTaskId` state.
  useEffect(() => {
    if (detailTaskId) setPending(null);
  }, [detailTaskId]);

  if (!engine || !projectId) return null; // no project: no create surface

  function startCreate(location: TaskLocation): void {
    const pid = requireProjectId(projectId); // write: never without a project
    void ensureMembers();
    onComposeOpen?.();
    const taskId = crypto.randomUUID();
    // Day-3: capture the 3D view BEFORE opening compose (same frame as
    // the tap). Null → placeholder, and creation never blocks on it.
    const handle = getHandle();
    const dataUrl = handle?.getSnapshot?.(400) ?? null;
    const { location: located, thumb } = attachSnapshotThumb(dataUrl, pid, taskId, location);
    setPending({ taskId, location: located, locationThumb: thumb });
  }

  return (
    <>
      <TapCreateMarker3D getHandle={getHandle} storeyName={storeyName} onCreate={startCreate} />
      {pending && projectId && (
        <TaskComposeSheet
          projectId={projectId}
          taskId={pending.taskId}
          actor={actor}
          members={members ?? []}
          engine={engine}
          draftTable={draftTable}
          location={pending.location}
          locationThumb={pending.locationThumb}
          onDone={() => setPending(null)}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}