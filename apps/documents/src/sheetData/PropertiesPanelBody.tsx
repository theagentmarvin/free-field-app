// apps/documents/src/sheetData/PropertiesPanelBody.tsx
//
// Body of the "Properties" panel (floating toolbar): the clicked element, or a
// short summary when a whole category is selected.

import type { CSSProperties, ReactNode } from "react";

import ElementPropertiesPanel from "./ElementPropertiesPanel";
import { useSheetDataStore } from "./sheetDataStore";

export default function PropertiesPanelBody(): ReactNode {
  const payload = useSheetDataStore((s) => s.payload);
  const gids = useSheetDataStore((s) => s.selectedGids);
  const category = useSheetDataStore((s) => s.selectedCategory);
  if (!payload) return <div style={hintStyle}>This PDF has no drawing data.</div>;
  if (gids.length === 0) {
    return (
      <div style={hintStyle} data-testid="properties-empty">
        Tap an element on the drawing, or pick one in Elements, to see its properties.
      </div>
    );
  }
  if (gids.length > 1) {
    return (
      <div style={hintStyle} data-testid="properties-multi">
        {gids.length} {category ?? "elements"} selected. Pick one element to see its properties.
      </div>
    );
  }
  return <ElementPropertiesPanel gid={gids[0]!} record={payload.elementRecords[gids[0]!]} />;
}

const hintStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: "var(--ff-text-muted)", padding: "8px 4px" };
