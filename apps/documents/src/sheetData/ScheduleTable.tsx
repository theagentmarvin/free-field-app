// apps/documents/src/sheetData/ScheduleTable.tsx
//
// A schedule placed on the sheet (columns + rows bound to elements by
// GlobalId): row click highlights the element on the drawing. (No export
// buttons in the UI for now; the CSV / XLSX writers stay in tableExport.ts.)

import type { CSSProperties, ReactNode } from "react";

import { toCell, type Table } from "./tableExport";
import type { SheetSchedule } from "./sheetPayload";

export function scheduleTable(s: SheetSchedule): Table {
  return {
    headers: s.columns.map((c) => c.heading),
    rows: s.rows.map((r) => s.columns.map((_, i) => toCell(r.cells[i] ?? ""))),
  };
}

export interface ScheduleTableProps {
  schedule: SheetSchedule;
  sheetNumber?: string;
  selectedGid: string | null;
  /** GlobalIds drawn on this sheet (rows for others are not selectable). */
  drawnGids: ReadonlySet<string>;
  onSelect: (gid: string) => void;
}

export default function ScheduleTable({
  schedule,
  selectedGid,
  drawnGids,
  onSelect,
}: ScheduleTableProps): ReactNode {
  const table = scheduleTable(schedule);
  return (
    <div style={rootStyle} data-testid="schedule-table">
      <div style={toolbarStyle}>
        <span style={countStyle} data-testid="schedule-count">
          {schedule.rows.length} rows
        </span>
      </div>
      <div style={scrollStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {table.headers.map((h, i) => (
                <th key={i} style={thStyle}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {schedule.rows.map((r, ri) => {
              const selectable = !!r.gid && drawnGids.has(r.gid);
              return (
                <tr
                  key={ri}
                  style={rowStyle(!!r.gid && r.gid === selectedGid, selectable)}
                  onClick={() => selectable && onSelect(r.gid!)}
                  data-testid="schedule-row"
                  data-gid={r.gid ?? ""}
                >
                  {table.headers.map((_, ci) => (
                    <td key={ci} style={tdStyle}>
                      {String(r.cells[ci] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minHeight: 0, flex: 1 };
const toolbarStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const countStyle: CSSProperties = { flex: 1, fontSize: 11, color: "var(--ff-text-muted)" };
const scrollStyle: CSSProperties = { overflow: "auto", minHeight: 0, flex: 1 };
const tableStyle: CSSProperties = { borderCollapse: "collapse", fontSize: 12, width: "100%" };
const thStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  textAlign: "left",
  padding: "3px 6px",
  fontWeight: 600,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-muted)",
  borderBottom: "1px solid var(--ff-border)",
  whiteSpace: "nowrap",
};
const tdStyle: CSSProperties = { padding: "3px 6px", borderBottom: "1px solid var(--ff-border)", color: "var(--ff-text-primary)" };
const rowStyle = (selected: boolean, selectable: boolean): CSSProperties => ({
  cursor: selectable ? "pointer" : "default",
  background: selected ? "rgba(37, 99, 235, 0.12)" : "transparent",
});
