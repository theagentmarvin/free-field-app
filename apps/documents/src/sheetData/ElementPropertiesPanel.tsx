// apps/documents/src/sheetData/ElementPropertiesPanel.tsx
//
// Properties of the picked element: category, family / type, level,
// source element id, GlobalId and a searchable parameter list.

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { paramDisplay } from "./elementRows";
import type { SheetElementRecord } from "./sheetPayload";

export interface ElementPropertiesPanelProps {
  gid: string;
  record: SheetElementRecord | undefined;
}

export default function ElementPropertiesPanel({ gid, record }: ElementPropertiesPanelProps): ReactNode {
  const [query, setQuery] = useState("");
  const params = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.entries(record?.params ?? {})
      .map(([name, p]) => ({ name, value: paramDisplay(p), type: !!p.t }))
      .filter((p) => p.value !== "")
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.value.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [record, query]);

  const typeLine = [record?.family, record?.type].filter(Boolean).join(" : ");
  const sourceId = record?.uid ?? "";
  return (
    <div style={rootStyle} data-testid="element-properties">
      <div style={titleStyle}>{record?.category || "Element"}</div>
      <dl style={dlStyle}>
        <Row label="Family / type" value={typeLine} />
        <Row label="Level" value={record?.level ?? ""} />
        <Row label="Source element id" value={sourceId + (record?.eid !== undefined ? ` (${record.eid})` : "")} />
        <Row label="GlobalId" value={gid} mono />
      </dl>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search parameters"
        aria-label="Search parameters"
        style={searchStyle}
        data-testid="element-param-search"
      />
      <div style={listStyle} data-testid="element-param-list">
        {params.length === 0 ? (
          <div style={mutedStyle}>{record ? "No matching parameters" : "No data for this element"}</div>
        ) : (
          params.map((p) => (
            <div key={p.name} style={paramRowStyle}>
              <span style={paramNameStyle} title={p.type ? "Type parameter" : "Instance parameter"}>
                {p.name}
              </span>
              <span style={paramValueStyle}>{p.value}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }): ReactNode {
  if (!value.trim()) return null;
  return (
    <div style={rowStyle}>
      <dt style={dtStyle}>{label}</dt>
      <dd style={{ ...ddStyle, fontFamily: mono ? "monospace" : undefined }}>{value}</dd>
    </div>
  );
}

const rootStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, minHeight: 0 };
const titleStyle: CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--ff-text-primary)" };
const dlStyle: CSSProperties = { margin: 0, display: "flex", flexDirection: "column", gap: 4 };
const rowStyle: CSSProperties = { display: "flex", gap: 8, fontSize: 12 };
const dtStyle: CSSProperties = { width: 110, flexShrink: 0, color: "var(--ff-text-muted)" };
const ddStyle: CSSProperties = { margin: 0, color: "var(--ff-text-primary)", wordBreak: "break-all" };
const searchStyle: CSSProperties = {
  height: 28,
  padding: "0 8px",
  fontSize: 12,
  border: "1px solid var(--ff-border)",
  borderRadius: 4,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
};
const listStyle: CSSProperties = { overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column" };
const paramRowStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "3px 0",
  fontSize: 12,
  borderBottom: "1px solid var(--ff-border)",
};
const paramNameStyle: CSSProperties = { width: 120, flexShrink: 0, color: "var(--ff-text-muted)" };
const paramValueStyle: CSSProperties = { color: "var(--ff-text-primary)", wordBreak: "break-word" };
const mutedStyle: CSSProperties = { fontSize: 12, color: "var(--ff-text-muted)", padding: "6px 0" };
