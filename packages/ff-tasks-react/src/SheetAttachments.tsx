import { useMemo, useState, type CSSProperties } from "react";

import type { SheetRef } from "@ff/tasks";

import { useSheetCatalog, openSheetRef } from "./sheetCatalog";
import {
  buildPickerSections,
  describeSheetRef,
  makeSheetRef,
  toggleSheetRef,
  type SheetCatalog,
} from "./sheetRefs";
import { chipStyle, tokens } from "./formStyles";

const { color: c, radius: r, space: s, fontSize: f } = tokens;

/**
 * Sheets attached to a task by reference: one chip per sheet (icon, name,
 * version badge such as "v1 (newer: v2)"). Click opens that version in
 * Documents; the optional × removes the reference (never the sheet).
 */
export function SheetChips({
  refs,
  catalog,
  projectId,
  onRemove,
}: {
  refs: readonly SheetRef[];
  catalog: SheetCatalog;
  projectId: string | null;
  onRemove?: (ref: SheetRef) => void;
}): JSX.Element | null {
  if (refs.length === 0) return null;
  return (
    <ul data-testid="sheet-chips" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: s.s2 }}>
      {refs.map((ref) => {
        const view = describeSheetRef(ref, catalog);
        const gone = view.status === "missing";
        return (
          <li
            key={`${ref.pdfFileId}:${ref.pdfVersionId}:${ref.page ?? ""}`}
            data-testid="sheet-chip"
            data-status={view.status}
            style={{ display: "flex", alignItems: "center", gap: s.s2 }}
          >
            <button
              type="button"
              data-testid="sheet-chip-open"
              disabled={gone}
              onClick={() => void openSheetRef(ref, projectId)}
              title={gone ? "This sheet no longer exists" : "Open in Documents"}
              aria-label={gone ? `${view.name} (removed)` : `Open ${view.name} in Documents`}
              style={{
                ...sheetChipStyle,
                cursor: gone ? "default" : "pointer",
                opacity: gone ? 0.6 : 1,
              }}
            >
              <span aria-hidden style={{ fontSize: 15 }}>📄</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
                {view.name}
                {ref.page && ref.page > 1 ? ` · p.${ref.page}` : ""}
              </span>
              <span
                data-testid="sheet-chip-badge"
                style={{
                  ...chipStyle,
                  fontSize: f.xs,
                  background: view.status === "current" ? c.focusRingTint : "#fbf0dd",
                  color: view.status === "current" ? c.focusRingInk : "#8a5a00",
                  borderColor: view.status === "current" ? c.focusRingLine : "#f0d9a8",
                }}
              >
                {view.label}
              </span>
            </button>
            {onRemove && (
              <button
                type="button"
                data-testid="sheet-chip-remove"
                aria-label={`Remove ${view.name}`}
                onClick={() => onRemove(ref)}
                style={removeStyle}
              >
                ✕
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Attach from project": a picker over the building's Documents sheets
 * with folders, search and the same version badges as the Documents list.
 * Selecting stores a REFERENCE (file + version), never a copy of the PDF.
 */
export function SheetPicker({
  projectId,
  buildingId,
  selected,
  onChange,
  onClose,
  catalog: catalogProp,
}: {
  projectId: string | null;
  buildingId: string | null;
  selected: readonly SheetRef[];
  onChange: (next: SheetRef[]) => void;
  onClose: () => void;
  /** test seam; defaults to the live catalog */
  catalog?: SheetCatalog;
}): JSX.Element {
  const live = useSheetCatalog(projectId);
  const catalog = catalogProp ?? live;
  const [query, setQuery] = useState("");
  const sections = useMemo(() => buildPickerSections(catalog, { buildingId, query }), [catalog, buildingId, query]);
  const isSelected = (fileId: string): boolean => selected.some((x) => x.pdfFileId === fileId);

  return (
    <div
      data-testid="sheet-picker"
      role="dialog"
      aria-label="Attach sheets from project"
      style={{ position: "fixed", inset: 0, zIndex: 300, background: c.scrim, display: "grid", placeItems: "center", padding: s.s4 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: "min(520px, 100%)",
          maxHeight: "min(640px, 100%)",
          display: "flex",
          flexDirection: "column",
          background: c.surface,
          borderRadius: r.lg,
          boxShadow: "0 18px 50px rgba(16,24,40,0.3)",
          overflow: "hidden",
          fontFamily: tokens.font,
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: s.s2, padding: `${s.s3}px ${s.s4}px`, borderBottom: `1px solid ${c.border}` }}>
          <b style={{ flex: 1, fontSize: f.lg }}>Attach from project</b>
          <button type="button" aria-label="Close" data-testid="sheet-picker-close" onClick={onClose} style={removeStyle}>
            ✕
          </button>
        </header>
        <div style={{ padding: `${s.s3}px ${s.s4}px` }}>
          <input
            data-testid="sheet-picker-search"
            type="search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sheets or folders"
            style={{ width: "100%", boxSizing: "border-box", height: 36, borderRadius: r.md, border: `1px solid ${c.borderStrong}`, padding: "0 12px", fontFamily: "inherit", fontSize: f.md }}
          />
        </div>
        <div style={{ overflowY: "auto", padding: `0 ${s.s4}px ${s.s3}px`, flex: 1 }}>
          {sections.length === 0 && (
            <p data-testid="sheet-picker-empty" style={{ color: c.muted, fontSize: f.md }}>
              {query ? "No sheets match your search." : "No sheets in this building yet."}
            </p>
          )}
          {sections.map((section) => (
            <section key={section.title} data-testid="sheet-picker-section" style={{ marginBottom: s.s3 }}>
              <p style={{ margin: `${s.s2}px 0 ${s.s1}px`, fontSize: f.xs, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: c.muted }}>
                {section.title}
              </p>
              {section.entries.map((e) => {
                const on = isSelected(e.fileId);
                return (
                  <button
                    key={e.fileId}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    data-testid="sheet-picker-row"
                    data-file-id={e.fileId}
                    onClick={() => {
                      const ref = makeSheetRef(e.fileId, catalog);
                      if (!ref) return;
                      // toggling off removes any version of this sheet
                      if (on) onChange(selected.filter((x) => x.pdfFileId !== e.fileId));
                      else onChange(toggleSheetRef(selected, ref));
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: s.s2,
                      padding: "9px 10px",
                      borderRadius: r.sm,
                      border: "none",
                      background: on ? c.focusRingTint : "transparent",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: f.md,
                      textAlign: "left",
                      color: c.text,
                    }}
                  >
                    <span aria-hidden>{on ? "☑" : "☐"}</span>
                    <span aria-hidden>📄</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.name}</span>
                    <span data-testid="sheet-picker-badge" style={{ ...chipStyle, fontSize: f.xs }}>{e.badge}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <footer style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: `${s.s3}px ${s.s4}px`, borderTop: `1px solid ${c.border}` }}>
          <span data-testid="sheet-picker-count" style={{ fontSize: f.md, color: c.text2 }}>
            {selected.length} attached
          </span>
          <button type="button" data-testid="sheet-picker-done" onClick={onClose} style={doneStyle}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

const sheetChipStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: s.s2,
  padding: "8px 10px",
  borderRadius: r.md,
  border: `1px solid ${c.border}`,
  background: c.surface2,
  fontFamily: "inherit",
  fontSize: f.md,
  fontWeight: 600,
  color: c.text,
};

const removeStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: r.pill,
  border: "none",
  background: "transparent",
  color: c.text2,
  cursor: "pointer",
  fontSize: 12,
};

const doneStyle: CSSProperties = {
  height: 36,
  padding: "0 18px",
  borderRadius: r.md,
  border: "none",
  background: c.primary,
  color: c.onPrimary,
  fontWeight: 700,
  fontFamily: "inherit",
  cursor: "pointer",
};
