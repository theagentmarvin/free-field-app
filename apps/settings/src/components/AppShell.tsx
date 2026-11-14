// src/components/AppShell.tsx
//
// Top-level layout for Free Field. Three zones per docs/TASK-3-UI.md
// "Component breakdown":
//   - Header (48px) at the top
//   - Sidebar (420px) on the left
//   - ViewerPanel filling the remaining space
//
// The active building id is the app-wide `useModelsToolStore`
// `activeBuildingId` (wave 63). The <Header> writes to it (via
// onActiveBuildingChange), and the <Sidebar> + <ViewerPanel> read it.
// Refresh starts at the first building via the <BuildingTabs>
// auto-select.
//
// The <IfcViewer>'s imperative ref is created here and threaded
// down to <ViewerPanel> (as a `viewerRef` prop) and made available
// to deeply-nested consumers (e.g. <MappedStoreysSection>) via the
// <ViewerHandleProvider> context. We need the context because the
// Mapped section lives inside the Sidebar tree, which is a sibling
// of the ViewerPanel — neither tree can reach the other as a prop.

import { ReactNode, useEffect, useRef } from "react";

import { db } from "@ff/data/db/database";
import { useRequiredProjectId } from "@ff/auth";
import type { IfcViewerHandle } from "@ff/viewer-react";
import { ViewerHandleProvider } from "@ff/viewer-react";
import { MobileStack, useModelsToolStore } from "@ff/viewer-tools";

import Header from "./Header";
import Sidebar from "./Sidebar";
import ViewerPanel from "./ViewerPanel";

// AppShell's outer dimensions are now RELATIVE (`100%`) instead of
// viewport-fixed (`100vh`/`100vw`) so it fits inside the unified
// MainShell's flex layout. The LeftRail takes its own width via
// var(--ff-left-rail-width); AppShell fills the remaining outlet
// space. Behavior is unchanged when rendered standalone (the outlet
// parent is sized to the viewport by MainShell).
const shellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  width: "100%",
  minHeight: 0,
  minWidth: 0,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
  overflow: "hidden",
};

const bodyStyle: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

export default function AppShell(): ReactNode {
  // Wave 63: the active building is the app-wide one (the same
  // shared store the rail, Models, Documents and Linkview use), so a
  // choice made in Settings survives module switches and vice versa.
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore((s) => s.setActiveBuildingId);

  // Imperative handle to the <IfcViewer> instance. Threaded down
  // to <ViewerPanel> and made available via <ViewerHandleProvider>
  // so the Mapped section in the sidebar can call
  // openLevel/closeLevel on it. Created here (not inside
  // ViewerPanel) because the provider needs the same ref object
  // the viewer is mounted with.
  const viewerRef = useRef<IfcViewerHandle>(null);

  // AppShell sits behind the shell's project gate, so the id is set.
  // (The local `projects` row is bootstrapped once, in MainShell.)
  const projectId = useRequiredProjectId();

  // If the active building was deleted (via a tab menu), the
  // BuildingTabs auto-selects the next one. We still guard here
  // for the case where the active id was stale from a different
  // tab (e.g. browser refresh before the first live query tick).
  useEffect(() => {
    if (activeBuildingId === null) return;
    let cancelled = false;
    (async () => {
      const b = await db.buildings.get(activeBuildingId);
      if (cancelled) return;
      if (!b) setActiveBuildingId(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBuildingId, setActiveBuildingId]);

  return (
    <div style={shellStyle} className="ff-app-shell">
      <Header
        projectId={projectId}
        activeBuildingId={activeBuildingId}
        onActiveBuildingChange={setActiveBuildingId}
      />
      {/* The ViewerHandleProvider wraps the body so the Mapped
          section (in the Sidebar subtree) can read the same ref
          object the <IfcViewer> is mounted with. We do this at
          the AppShell level rather than ViewerPanel so the
          context is in scope for both the sidebar and the viewer
          sibling trees. */}
      <ViewerHandleProvider viewerRef={viewerRef}>
        <div style={bodyStyle}>
          {/* Task 36 — the sidebar↔viewer row. On desktop it is the
              same side-by-side layout as before; on phones
              <MobileStack> turns the sidebar into a top sheet above
              the viewer. The sidebar keeps its own width token. */}
          <MobileStack
            sidebar={<Sidebar buildingId={activeBuildingId} />}
            main={
              <ViewerPanel
                projectId={projectId}
                buildingId={activeBuildingId}
                viewerRef={viewerRef}
              />
            }
            sidebarWidth="var(--ff-sidebar-width)"
          />
        </div>
      </ViewerHandleProvider>
    </div>
  );
}
