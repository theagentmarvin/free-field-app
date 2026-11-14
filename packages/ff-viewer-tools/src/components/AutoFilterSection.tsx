// packages/ff-viewer-tools/src/components/AutoFilterSection.tsx
//
// Renders the two AUTO folders (Models + Levels):
//   - Models   ← live query on `ifcFiles` for the active building
//   - Levels   ← live query on `storeys` for the latest version per file
//
// Per Addendum B §B.1:
//   - Auto folder labels are fixed ("Models", "Levels"); cannot be renamed.
//   - Auto folders cannot be deleted or nested.
//   - Auto entries CAN be hidden via the eye toggle and activated via
//     the funnel toggle, but they cannot be renamed or deleted.
//   - Each folder is individually collapsible.
//
// Wave 35 (toolbar-nav redesign) — this section is now the BODY of
// the "Models & Levels" tenant of the one floating nav panel, so it
// gained two knobs:
//   - `showSectionHeader={false}` drops the "Auto (managed)" banner
//     and promotes each folder to a titled GROUP ("Models" / "Levels")
//     — that is what the panel shows.
//   - `onOpenLevel` turns a LEVEL row into an "open this level" action
//     (the host calls `viewerRef.openLevel(name)`); `activeLevelName`
//     marks the row that is currently open.
//   The visibility toggle became an iOS-style switch (36×21).
//
// The section is non-collapsible as a whole; its two children are.
// Toolbar buttons (`+` folder, `+` filter) are disabled when the
// section header is the active target — the parent component handles
// that since it owns the toolbar.
//
// Element addressing: the spec is firm that we never expose IFC
// schema versions in the filter UI. "Version" here is
// `IfcVersionRecord.versionNumber`, surfaced as `v1, v2, v3…`
// subtitles on Models entries.

import {
  type CSSProperties,
  type RefObject,
} from "react";

import type { IfcViewerHandle } from "@ff/viewer-react";

import type { FilterState } from "../modelsToolStore";
import type { AutoFilterEntry } from "../dataSource";
import VisibilitySwitch from "./VisibilitySwitch";

const INDENT_PX = 16;
const ROW_HEIGHT = 32;

// AutoFilterEntry is defined canonically in dataSource.ts (the DI
// boundary) so the section component, the FiltersPanel live query,
// and the app adapter all agree on one shape. Re-exported here to
// preserve the existing `import { AutoFilterEntry } from
// "./AutoFilterSection"` call sites.
export type { AutoFilterEntry };

export interface AutoFilterSectionProps {
  models: AutoFilterEntry[];
  levels: AutoFilterEntry[];
  filters: FilterState["auto"];
  onToggleActive: (
    group: "models" | "levels",
    entryId: string,
    enabled: boolean,
  ) => void;
  onToggleHidden: (
    group: "models" | "levels",
    entryId: string,
    hidden: boolean,
  ) => void;
  onToggleExpanded: (
    group: "models" | "levels",
    expanded: boolean,
  ) => void;
  /**
   * Wave 35 — show the "Auto (managed)" banner above the folders.
   * The panel body turns it OFF and promotes each folder to a
   * titled group instead. Defaults to true (legacy sidebar look).
   */
  showSectionHeader?: boolean;
  /**
   * Wave 35 — called when the user activates a LEVEL row. The host
   * opens the level plan on the viewer (`viewerRef.openLevel`).
   * Omitted → level rows stay inert labels.
   */
  onOpenLevel?: (levelName: string) => void;
  /**
   * Wave 35 — name of the currently open level (drives the "open"
   * badge on the matching row).
   */
  activeLevelName?: string | null;
  /** Forwarded for downstream use; not consumed in this section. */
  viewerRef?: RefObject<IfcViewerHandle>;
}

export default function AutoFilterSection({
  models,
  levels,
  filters,
  onToggleActive,
  onToggleHidden,
  onToggleExpanded,
  showSectionHeader = true,
  onOpenLevel,
  activeLevelName = null,
}: AutoFilterSectionProps): JSX.Element {
  const sectionStyle: CSSProperties = {
    paddingTop: showSectionHeader ? 8 : 0,
    paddingBottom: 4,
  };

  return (
    <div style={sectionStyle} data-testid="models-auto-section">
      {showSectionHeader && <SectionHeader label="Auto (managed)" />}
      <AutoFolder
        kind="models"
        label="Models"
        entries={models}
        enabled={filters.models.enabled}
        hidden={filters.models.hidden}
        expanded={filters.expanded.models}
        onToggleActive={onToggleActive}
        onToggleHidden={onToggleHidden}
        onToggleExpanded={onToggleExpanded}
        showGroupLabel={!showSectionHeader}
      />
      <AutoFolder
        kind="levels"
        label="Levels"
        entries={levels}
        enabled={filters.levels.enabled}
        hidden={filters.levels.hidden}
        expanded={filters.expanded.levels}
        onToggleActive={onToggleActive}
        onToggleHidden={onToggleHidden}
        onToggleExpanded={onToggleExpanded}
        showGroupLabel={!showSectionHeader}
        onOpenLevel={onOpenLevel}
        activeLevelName={activeLevelName}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Section header (small caps, gray)
// ────────────────────────────────────────────────────────────────────────

function SectionHeader({ label }: { label: string }): JSX.Element {
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 16px 6px",
    color: "var(--ff-text-muted)",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    borderTop: "1px solid var(--ff-divider)",
    borderBottom: "1px solid var(--ff-divider)",
    background: "var(--ff-bg-app)",
    textAlign: "left",
    // border-box: width:100% + 16px side padding must stay INSIDE the
    // panel body — content-box overflowed 32px and clipped at the edge.
    width: "100%",
    boxSizing: "border-box",
  };
  return (
    <div style={style} data-testid="auto-section-header">
      {label}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Group label — the "Models" / "Levels" headings of the panel body.
// ────────────────────────────────────────────────────────────────────────

function GroupLabel({ label }: { label: string }): JSX.Element {
  const style: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: "0.11em",
    textTransform: "uppercase",
    color: "var(--ff-text-muted)",
    padding: "12px 9px 4px",
  };
  return (
    <div style={style} data-testid={`auto-group-${label.toLowerCase()}`}>
      {label}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Auto folder (locked label, no nesting, no rename/delete/duplicate)
// ────────────────────────────────────────────────────────────────────────

interface AutoFolderProps {
  kind: "models" | "levels";
  label: string;
  entries: AutoFilterEntry[];
  enabled: Set<string>;
  hidden: Set<string>;
  expanded: boolean;
  onToggleActive: (
    group: "models" | "levels",
    entryId: string,
    enabled: boolean,
  ) => void;
  onToggleHidden: (
    group: "models" | "levels",
    entryId: string,
    hidden: boolean,
  ) => void;
  onToggleExpanded: (
    group: "models" | "levels",
    expanded: boolean,
  ) => void;
  /** Wave 35 — render the folder as a titled group (panel body mode). */
  showGroupLabel?: boolean;
  /** Wave 35 — level rows become "open level" actions. */
  onOpenLevel?: (levelName: string) => void;
  /** Wave 35 — the currently open level. */
  activeLevelName?: string | null;
}

function AutoFolder({
  kind,
  label,
  entries,
  enabled,
  hidden,
  expanded,
  onToggleActive,
  onToggleHidden,
  onToggleExpanded,
  showGroupLabel = false,
  onOpenLevel,
  activeLevelName = null,
}: AutoFolderProps): JSX.Element {
  const count = entries.length;

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: ROW_HEIGHT,
    paddingLeft: 9,
    paddingRight: 8,
    gap: 4,
    color: "var(--ff-text-primary)",
    fontSize: 13,
    userSelect: "none",
    fontWeight: 500,
    cursor: "pointer",
    borderRadius: 8,
  };

  return (
    <div>
      {showGroupLabel && <GroupLabel label={label} />}
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        data-testid={`auto-folder-${kind}`}
      >
        <div
          style={headerStyle}
          onClick={() => onToggleExpanded(kind, !expanded)}
          data-testid={`auto-folder-${kind}-header`}
        >
          <ChevronIcon rotated={expanded} />
          <FolderIcon />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--ff-text-muted)",
              fontWeight: 400,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ({count})
          </span>
        </div>
        {expanded && (
          <div role="group" aria-label={`${label} entries`}>
            {entries.length === 0 ? (
              <EmptyAutoEntries kind={kind} />
            ) : (
              entries.map((entry) => (
                <AutoEntryRow
                  key={entry.id}
                  kind={kind}
                  entry={entry}
                  isActive={enabled.has(entry.id)}
                  isHidden={hidden.has(entry.id)}
                  onToggleActive={(v) => onToggleActive(kind, entry.id, v)}
                  onToggleHidden={(v) => onToggleHidden(kind, entry.id, v)}
                  onOpenLevel={onOpenLevel}
                  isLevelOpen={
                    kind === "levels" && activeLevelName === entry.label
                  }
                />
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyAutoEntries({ kind }: { kind: "models" | "levels" }): JSX.Element {
  const style: CSSProperties = {
    padding: "6px 12px 8px 36px",
    color: "var(--ff-text-muted)",
    fontSize: 12,
    fontStyle: "italic",
  };
  const hint =
    kind === "models"
      ? "No IFCs yet. Upload one in Settings."
      : "No levels parsed yet.";
  return (
    <div style={style} data-testid={`auto-folder-${kind}-empty`}>
      {hint}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Auto entry row (locked label, but eye + funnel are user-managed)
// ────────────────────────────────────────────────────────────────────────

interface AutoEntryRowProps {
  kind: "models" | "levels";
  entry: AutoFilterEntry;
  isActive: boolean;
  isHidden: boolean;
  onToggleActive: (active: boolean) => void;
  onToggleHidden: (hidden: boolean) => void;
  /** Wave 35 — open-this-level action (levels only). */
  onOpenLevel?: (levelName: string) => void;
  /** Wave 35 — this level is the open one. */
  isLevelOpen?: boolean;
}

function AutoEntryRow({
  kind,
  entry,
  isActive,
  isHidden,
  onToggleActive,
  onToggleHidden,
  onOpenLevel,
  isLevelOpen = false,
}: AutoEntryRowProps): JSX.Element {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: ROW_HEIGHT,
    paddingLeft: 12 + INDENT_PX,
    paddingRight: 8,
    gap: 4,
    color: isHidden ? "var(--ff-text-muted)" : "var(--ff-text-primary)",
    fontSize: 13,
    userSelect: "none",
    borderRadius: 8,
    borderLeft: isActive
      ? "2px solid var(--ff-blue-active)"
      : "2px solid transparent",
    background: isActive ? "rgba(37, 99, 235, 0.04)" : "transparent",
    transition: "background 120ms ease",
  };

  const labelStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textDecoration: isHidden ? "line-through" : "none",
    textAlign: "left",
    background: "transparent",
    border: "none",
    padding: 0,
    font: "inherit",
    color: "inherit",
    cursor: onOpenLevel ? "pointer" : "default",
  };

  const subtitleStyle: CSSProperties = {
    fontSize: 11,
    color: "var(--ff-text-muted)",
    fontWeight: 400,
    marginLeft: 6,
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      style={rowStyle}
      role="treeitem"
      aria-level={2}
      aria-selected={isActive}
      data-testid={`auto-entry-${kind}-${entry.id}`}
      data-row-kind={kind}
    >
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--ff-text-secondary)",
          flexShrink: 0,
        }}
      >
        <FunnelIcon />
      </span>
      {onOpenLevel ? (
        <button
          type="button"
          onClick={() => onOpenLevel(entry.label)}
          style={labelStyle}
          title={`Open ${entry.label}`}
          data-testid={`auto-entry-${kind}-${entry.id}-open`}
        >
          {entry.label}
        </button>
      ) : (
        <span style={labelStyle} title={entry.label}>
          {entry.label}
        </span>
      )}
      {isLevelOpen && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "1px 7px",
            borderRadius: 999,
            background: "rgba(14, 148, 136, 0.1)",
            color: "#0e9488",
            flexShrink: 0,
          }}
          data-testid={`auto-entry-${kind}-${entry.id}-open-badge`}
        >
          open
        </span>
      )}
      <span style={subtitleStyle} aria-label="subtitle">
        {entry.subtitle}
      </span>
      <RowActions
        isActive={isActive}
        isHidden={isHidden}
        onToggleActive={onToggleActive}
        onToggleHidden={onToggleHidden}
        testId={`auto-entry-${kind}-${entry.id}`}
        label={entry.label}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Per-row actions (funnel + iOS visibility switch — no three-dots for
// auto entries per §B.1: only "Open properties" would be available and
// that's not in scope this session).
// ────────────────────────────────────────────────────────────────────────

interface RowActionsProps {
  isActive: boolean;
  isHidden: boolean;
  onToggleActive: (active: boolean) => void;
  onToggleHidden: (hidden: boolean) => void;
  testId: string;
  /** Row label — used for the switch's accessible name. */
  label: string;
}

function RowActions({
  isActive,
  isHidden,
  onToggleActive,
  onToggleHidden,
  testId,
  label,
}: RowActionsProps): JSX.Element {
  const funnelStyle: CSSProperties = {
    width: 22,
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: isActive ? "rgba(37, 99, 235, 0.08)" : "transparent",
    border: "none",
    borderRadius: 4,
    color: isActive ? "var(--ff-blue-active)" : "var(--ff-text-muted)",
    cursor: "pointer",
    padding: 0,
    transition: "background 120ms ease, color 120ms ease",
  };

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label={isActive ? "Deactivate filter" : "Activate filter"}
        aria-pressed={isActive}
        title={isActive ? "Deactivate" : "Activate"}
        onClick={() => onToggleActive(!isActive)}
        style={funnelStyle}
        data-testid={`${testId}-toggle`}
      >
        <FunnelIcon size={12} />
      </button>
      <VisibilitySwitch
        checked={!isHidden}
        onChange={(visible) => onToggleHidden(!visible)}
        label={`${isHidden ? "Show" : "Hide"} ${label}`}
        testId={`${testId}-visibility`}
      />
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Icons — inline SVGs (kept identical to the FiltersPanel mockup so
// visual parity with the shipped mockup is preserved).
// ────────────────────────────────────────────────────────────────────────

function FolderIcon(): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function FunnelIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 4h18l-7 9v6l-4 2v-8z" />
    </svg>
  );
}

function ChevronIcon({ rotated }: { rotated: boolean }): JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        transition: "transform 120ms ease",
        transform: rotated ? "rotate(90deg)" : "rotate(0deg)",
      }}
    >
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}
