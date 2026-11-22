// Quick access from a task's location: the shell half. A task thumb /
// detail card posts an open intent (@ff/tasks-react); this switches the
// building when the target belongs to another one, then routes to Models,
// Documents or LinkView (tasks created there), which consume the intent
// once their surface is ready.
// Also hosts the global notice ("plan no longer exists", "showing v2").

import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { TaskOpenNotice, useTaskOpenState } from "@ff/tasks-react";
import { useModelsToolStore } from "@ff/viewer-tools";

export function TaskOpenBridge(): JSX.Element {
  const { intent } = useTaskOpenState();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore((s) => s.setActiveBuildingId);

  useEffect(() => {
    if (!intent) return;
    if (intent.buildingId && intent.buildingId !== activeBuildingId) {
      setActiveBuildingId(intent.buildingId);
    }
    const route =
      intent.kind === "models" ? "/models" : intent.kind === "linkview" ? "/linkview" : "/documents";
    if (pathname !== route) navigate(route);
    // one hop per request
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intent?.id]);

  return <TaskOpenNotice />;
}
