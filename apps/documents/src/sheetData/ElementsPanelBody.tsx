// apps/documents/src/sheetData/ElementsPanelBody.tsx
//
// Body of the "Elements" panel: the drawing's elements grouped by category
// with counts. Clicking a category selects and highlights ALL its instances on
// the PDF (again, or another category, changes the selection); clicking one
// element selects it and opens its properties.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { buildElementRows, categoryCounts, type ElementRow } from "./elementRows";
import { useSheetDataStore } from "./sheetDataStore";

export interface ElementsPanelBodyProps {
  /** Called after an individual element was picked (to show its properties). */
  onElementPicked?: () => void;
}

export default function ElementsPanelBody({ onElementPicked }: ElementsPanelBodyProps): ReactNode {
  const payload = useSheetDataStore((s) => s.payload);
  const selectedCategory = useSheetDataStore((s) => s.selectedCategory);
  const selectedGids = useSheetDataStore((s) => s.selectedGids);
  const selectCategory = useSheetDataStore((s) => s.selectCategory);
  const selectElement = useSheetDataStore((s) => s.selectElement);
  const [search, setSearch] = useState("");

  const rows = useMemo(() => (payload ? buildElementRows(payload) : []), [payload]);
  const counts = useMemo(() => categoryCounts(rows), [rows]);
  const byCategory = useMemo(() => {
    const m = new Map<string, ElementRow[]>();
    for (const r of rows) {
      const l = m.get(r.category) ?? [];
      l.push(r);
      m.set(r.category, l);
    }
    return m;
  }, [rows]);

  if (!payload) return <div style={hintStyle}>This PDF has no drawing data.</div>;
  const q = search.trim().toLowerCase();
  return (
    <div style={rootStyle} data-testid="elements-panel">
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Filter elements"
        aria-label="Filter elements"
        style={searchStyle}
      />
      <div style={listStyle}>
        {counts.map(({ category, count }) => {
          const open = selectedCategory === category || (q !== "" && true);
          const list = (byCategory.get(category) ?? []).filter(
            (r) => !q || [r.family, r.type, r.level, r.gid, r.mark].join(" ").toLowerCase().includes(q) || category.toLowerCase().includes(q),
          );
          if (q && list.length === 0) return null;
          return (
            <div key={category}>
              <button
                type="button"
                style={categoryStyle(selectedCategory === category)}
                onClick={() => selectCategory(category)}
                aria-pressed={selectedCategory === category}
                data-testid="elements-category"
                data-category={category}
              >
                <span style={catNameStyle}>{category}</span>
                <span style={countStyle}>{count}</span>
              </button>
              {open
                ? list.map((r) => (
                    <button
                      key={r.gid}
                      type="button"
                      style={rowStyle(selectedGids.length === 1 && selectedGids[0] === r.gid)}
                      onClick={() => {
                        selectElement(r.gid);
                        onElementPicked?.();
                      }}
                      data-testid="elements-row"
                      data-gid={r.gid}
                    >
                      <span style={catNameStyle}>{[r.family, r.type].filter(Boolean).join(" : ") || r.mark || r.gid}</span>
                      <span style={subStyle}>{r.level}</span>
                    </button>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const rootStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minHeight: 0, flex: 1 };
const hintStyle: CSSProperties = { fontSize: 13, color: "var(--ff-text-muted)", padding: "8px 4px" };
const searchStyle: CSSProperties = {
  height: 28,
  padding: "0 8px",
  fontSize: 12,
  border: "1px solid var(--ff-border)",
  borderRadius: 4,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
};
const listStyle: CSSProperties = { overflowY: "auto", minHeight: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2 };
const categoryStyle = (on: boolean): CSSProperties => ({
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "left",
  cursor: "pointer",
  border: on ? "1px solid rgba(37, 99, 235, 0.35)" : "1px solid transparent",
  borderRadius: 6,
  background: on ? "rgba(37, 99, 235, 0.1)" : "transparent",
  color: on ? "var(--ff-blue-active)" : "var(--ff-text-primary)",
});
const catNameStyle: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const countStyle: CSSProperties = { flexShrink: 0, fontSize: 11, color: "var(--ff-text-muted)" };
const rowStyle = (selected: boolean): CSSProperties => ({
  display: "flex",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  padding: "3px 8px 3px 22px",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
  border: "none",
  borderRadius: 3,
  background: selected ? "rgba(37, 99, 235, 0.12)" : "transparent",
  color: "var(--ff-text-primary)",
});
const subStyle: CSSProperties = { flexShrink: 0, color: "var(--ff-text-muted)" };
