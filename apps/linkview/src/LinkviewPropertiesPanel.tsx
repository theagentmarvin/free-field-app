// apps/linkview/src/LinkviewPropertiesPanel.tsx
//
// Selection properties for the LinkView right (first-person) pane —
// the same <PropertiesDrawer variant="body"> content the Models
// module shows in its floating nav panel, hosted in a <FrostedNavSlot>
// anchored to the RIGHT edge of the right pane so it never covers the
// PDF on the left or the tools toolbar at the top-left.
//
// Why this exists: the pick pipeline already worked in LinkView (the
// shared surface selects + the store updates), but the old bottom
// "drawer" variant rendered a collapsed 39px one-line bar
// ("IfcBuilding (#123) · 4 psets ▴") that nobody noticed. Here the
// panel opens with the full property sections on selection and closes
// (Escape / ✕ / empty-space click) with it, exactly like Models.
//
// <PropertiesDrawer> stays mounted for the whole session — its
// `setOnElementPick` subscription must be installed once.

import { useCallback, type ReactNode, type RefObject } from "react";

import {
  FrostedNavSlot,
  PropertiesDrawer,
  useIsMobile,
  useModelsToolStore,
} from "@ff/viewer-tools";
import type { IfcViewerHandle } from "@ff/viewer-react";

export interface LinkviewPropertiesPanelProps {
  /** Handle to the shared 3D surface (right pane). */
  viewerRef: RefObject<IfcViewerHandle>;
}

export default function LinkviewPropertiesPanel({
  viewerRef,
}: LinkviewPropertiesPanelProps): ReactNode {
  const selected = useModelsToolStore((s) => s.selection);
  const isMobile = useIsMobile();
  const onClose = useCallback(() => {
    useModelsToolStore.getState().clearSelection();
  }, []);

  return (
    // FrostedNavSlot positions itself `left: 14` inside its nearest
    // positioned ancestor; this wrapper is that ancestor, hugging the
    // right edge. It ignores the pointer so drag-to-look / click-to-pick
    // reach the canvas around the panel.
    <div
      data-testid="linkview-properties-anchor"
      style={
        isMobile
          ? { position: "absolute", inset: 0, pointerEvents: "none", zIndex: 21 }
          : {
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 348,
              pointerEvents: "none",
              zIndex: 21,
            }
      }
    >
      <div style={{ pointerEvents: "auto" }}>
        <FrostedNavSlot
          open={selected !== null}
          title="Properties"
          onClose={onClose}
          mobile={isMobile}
          ariaLabel="Properties panel"
          testId="linkview-properties-panel"
          dataPanel="props"
        >
          <PropertiesDrawer viewerRef={viewerRef} variant="body" />
        </FrostedNavSlot>
      </div>
    </div>
  );
}
