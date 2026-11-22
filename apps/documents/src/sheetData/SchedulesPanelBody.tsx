// apps/documents/src/sheetData/SchedulesPanelBody.tsx
//
// Body of the "Schedules" panel: the schedules placed on the sheet. Picking
// one shows its table; a row highlights its element on the drawing. (No
// export buttons for now: the CSV / XLSX writers stay in tableExport.ts.)

import { useState, type CSSProperties, type ReactNode } from "react";

import ScheduleTable from "./ScheduleTable";
import { useSheetDataStore } from "./sheetDataStore";

export default function SchedulesPanelBody(): ReactNode {
  const payload = useSheetDataStore((s) => s.payload);
  const gids = useSheetDataStore((s) => s.selectedGids);
  const selectElement = useSheetDataStore((s) => s.selectElement);
  const [open, setOpen] = useState<number | null>(null);
  if (!payload || payload.schedules.length === 0) return <div style={hintStyle}>No schedules on this sheet.</div>;
  const drawn = new Set(payload.elements.map((e) => e.gid));
  const chosen = open !== null ? payload.schedules[open] : undefined;
  if (chosen) {
    return (
      <div style={rootStyle}>
        <button type="button" style={backStyle} onClick={() => setOpen(null)} data-testid="schedules-back">
          ← All schedules
        </button>
        <div style={titleStyle}>{chosen.name}</div>
        <ScheduleTable
          schedule={chosen}
          sheetNumber={payload.sheetNumber}
          selectedGid={gids.length === 1 ? gids[0]! : null}
          drawnGids={drawn}
          onSelect={(gid) => selectElement(gid)}
        />
      </div>
    );
  }
  return (
    <div style={rootStyle} data-testid="schedules-list">
      {payload.schedules.map((s, i) => (
        <button key={i} type="button" style={itemStyle} onClick={() => setOpen(i)} data-testid="schedule-item">
          <span>{s.name}</span>
          <span style={countStyle}>{s.rows.length} rows</span>
        </button>
      ))}
    </div>
  );
}

const rootStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minHeight: 0, flex: 1 };
const hintStyle: CSSProperties = { fontSize: 13, color: "var(--ff-text-muted)", padding: "8px 4px" };
const itemStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  padding: "8px",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "left",
  cursor: "pointer",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
  background: "transparent",
  color: "var(--ff-text-primary)",
};
const countStyle: CSSProperties = { fontSize: 11, fontWeight: 400, color: "var(--ff-text-muted)" };
const backStyle: CSSProperties = { alignSelf: "flex-start", border: "none", background: "transparent", cursor: "pointer", color: "var(--ff-blue-active)", fontSize: 12, padding: 0 };
const titleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--ff-text-primary)" };
