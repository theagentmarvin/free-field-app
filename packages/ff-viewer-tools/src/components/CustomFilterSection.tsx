// apps/models/src/components/CustomFilterSection.tsx
//
// Renders the user-created filter tree (Custom section). Per
// Addendum B §B.1:
//   - Arbitrary nesting depth.
//   - Folder and filter labels are editable (rename via the dots menu).
//   - Dots menu also has Delete and Duplicate.
//   - Toolbar `+` folder / `+` filter buttons create at the top level
//     of the Custom section.
//
// This component is a controlled renderer — it reads `tree` from the
// store and dispatches the corresponding actions on user input.
// Internal presentation mirrors the FiltersPanel mockup (iconoir-style
// folder + per-row funnel/eye/dots).

import {
  type CSSProperties,
  type ReactNode,
  useMemo,
  useState,
} from "react";

import { countPresetMatches } from "../hooks/customPresetEvaluator";
import { usePropertyIndexStore } from "../propertyIndexStore";

import type {
  FilterState,
  UserFilterGroup,
  UserFilterLeaf,
  UserFilterNode,
} from "../modelsToolStore";

import VisibilitySwitch from "./VisibilitySwitch";

const INDENT_PX = 16;
const ROW_HEIGHT = 32;

export interface CustomFilterSectionProps {
  tree: UserFilterGroup[];
  filters: FilterState;
  /** Called when the user wants to create a new top-level folder. */
  onCreateFolder: () => void;
  /** Called when the user wants to create a new top-level filter. */
  onCreateFilter: () => void;
  toggleCustomExpanded: (folderId: string) => void;
  setCustomFilterActive: (
    groupId: string,
    entryId: string,
    active: boolean,
  ) => void;
  setCustomFilterHidden: (
    groupId: string,
    entryId: string,
    hidden: boolean,
  ) => void;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  /**
   * Task 20D — called when the user wants to edit a filter leaf.
   * The parent (FiltersPanel) opens the CustomFilterBuilder modal
   * in EDIT mode for the given leaf id. Optional — when omitted,
   * the leaf row's three-dots menu hides the Edit action.
   */
  onEditLeaf?: (leafId: string) => void;
}

export default function CustomFilterSection({
  tree,
  filters,
  toggleCustomExpanded,
  setCustomFilterActive,
  setCustomFilterHidden,
  renameCustom,
  deleteCustom,
  onEditLeaf,
}: CustomFilterSectionProps): JSX.Element {
  return (
    <div data-testid="models-custom-section">
      <SectionHeader />
      {tree.length === 0 ? (
        <EmptyCustomState />
      ) : (
        tree.map((group) => (
          <CustomGroupNode
            key={group.id}
            group={group}
            depth={0}
            filters={filters}
            toggleCustomExpanded={toggleCustomExpanded}
            setCustomFilterActive={setCustomFilterActive}
            setCustomFilterHidden={setCustomFilterHidden}
            renameCustom={renameCustom}
            deleteCustom={deleteCustom}
            onEditLeaf={onEditLeaf}
          />
        ))
      )}
    </div>
  );
}

function SectionHeader(): JSX.Element {
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
    <div style={style} data-testid="custom-section-header">
      Custom
    </div>
  );
}

function EmptyCustomState(): JSX.Element {
  const style: CSSProperties = {
    padding: "10px 16px 12px",
    color: "var(--ff-text-muted)",
    fontSize: 12,
    lineHeight: 1.5,
  };
  return (
    <div style={style} data-testid="custom-section-empty">
      No custom filters yet.
      <br />
      Use the toolbar above to create one.
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Custom group node (recursive) — renders the folder row + its children
// ────────────────────────────────────────────────────────────────────────

interface CustomGroupNodeProps {
  group: UserFilterGroup;
  depth: number;
  filters: FilterState;
  toggleCustomExpanded: (folderId: string) => void;
  setCustomFilterActive: (
    groupId: string,
    entryId: string,
    active: boolean,
  ) => void;
  setCustomFilterHidden: (
    groupId: string,
    entryId: string,
    hidden: boolean,
  ) => void;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  onEditLeaf?: (leafId: string) => void;
}

function CustomGroupNode({
  group,
  depth,
  filters,
  toggleCustomExpanded,
  setCustomFilterActive,
  setCustomFilterHidden,
  renameCustom,
  deleteCustom,
  onEditLeaf,
}: CustomGroupNodeProps): JSX.Element {
  const groupActive = filters.customActive.get(group.id) ?? new Set<string>();
  const groupHidden = filters.customHidden.get(group.id) ?? new Set<string>();

  const headerStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: ROW_HEIGHT,
    paddingLeft: 12 + depth * INDENT_PX,
    paddingRight: 8,
    gap: 4,
    color: "var(--ff-text-primary)",
    fontSize: 13,
    userSelect: "none",
    fontWeight: 500,
  };

  return (
    <div role="treeitem" aria-level={depth + 1} aria-expanded={group.expanded} data-testid={`custom-group-${group.id}`}>
      <div style={headerStyle} data-testid={`custom-group-${group.id}-header`}>
        <button
          type="button"
          aria-label={group.expanded ? "Collapse" : "Expand"}
          onClick={() => toggleCustomExpanded(group.id)}
          style={{
            width: 16,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "none",
            color: "var(--ff-text-muted)",
            cursor: "pointer",
            padding: 0,
            borderRadius: 3,
          }}
        >
          <ChevronIcon rotated={group.expanded} />
        </button>
        <FolderIcon />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={group.label}
        >
          {group.label}
        </span>
        <CustomGroupActions
          nodeId={group.id}
          renameCustom={renameCustom}
          deleteCustom={deleteCustom}
          currentLabel={group.label}
        />
      </div>
      {group.expanded && (
        <div role="group" aria-label={`${group.label} entries`}>
          {group.children.map((child) =>
            child.kind === "user" ? (
              <CustomGroupNode
                key={child.id}
                group={child}
                depth={depth + 1}
                filters={filters}
                toggleCustomExpanded={toggleCustomExpanded}
                setCustomFilterActive={setCustomFilterActive}
                setCustomFilterHidden={setCustomFilterHidden}
                renameCustom={renameCustom}
                deleteCustom={deleteCustom}
                onEditLeaf={onEditLeaf}
              />
            ) : (
              <CustomLeafRow
                key={child.id}
                leaf={child}
                depth={depth + 1}
                isActive={groupActive.has(child.id)}
                isHidden={groupHidden.has(child.id)}
                setCustomFilterActive={setCustomFilterActive}
                setCustomFilterHidden={setCustomFilterHidden}
                renameCustom={renameCustom}
                deleteCustom={deleteCustom}
                onEditLeaf={onEditLeaf}
              />
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Custom filter leaf row (funnel + eye + dots with rename / delete)
// ────────────────────────────────────────────────────────────────────────

interface CustomLeafRowProps {
  leaf: UserFilterLeaf;
  depth: number;
  isActive: boolean;
  isHidden: boolean;
  setCustomFilterActive: (
    groupId: string,
    entryId: string,
    active: boolean,
  ) => void;
  setCustomFilterHidden: (
    groupId: string,
    entryId: string,
    hidden: boolean,
  ) => void;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  onEditLeaf?: (leafId: string) => void;
}

function CustomLeafRow({
  leaf,
  depth,
  isActive,
  isHidden,
  setCustomFilterActive,
  setCustomFilterHidden,
  renameCustom,
  deleteCustom,
  onEditLeaf,
}: CustomLeafRowProps): JSX.Element {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    height: ROW_HEIGHT,
    paddingLeft: 12 + depth * INDENT_PX,
    paddingRight: 8,
    gap: 4,
    color: isHidden ? "var(--ff-text-muted)" : "var(--ff-text-primary)",
    fontSize: 13,
    userSelect: "none",
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
  };

  // Wave 63: an ACTIVE filter that matches nothing is skipped by the
  // resolver (it would otherwise hide every element), so flag it.
  // Only once the property index exists — before that, every preset
  // would read as 0.
  const indices = usePropertyIndexStore((s) => s.indices);
  const allLocalIds = usePropertyIndexStore((s) => s.allLocalIds);
  const zeroMatches = useMemo(
    () =>
      isActive &&
      !isHidden &&
      indices.size > 0 &&
      countPresetMatches(leaf.preset, indices, allLocalIds) === 0,
    [isActive, isHidden, indices, allLocalIds, leaf.preset],
  );

  return (
    <div
      style={rowStyle}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isActive}
      data-testid={`custom-leaf-${leaf.id}`}
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
          visibility: "hidden",
        }}
      >
        <ChevronIcon rotated={false} />
      </span>
      <FunnelIcon />
      <span style={labelStyle} title={leaf.label}>
        {leaf.label}
      </span>
      {zeroMatches && (
        <span
          data-testid={`custom-leaf-${leaf.id}-zero-matches`}
          title="This filter matches no elements in the loaded models, so it is not applied."
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 600,
            color: "var(--ff-text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          0 matches
        </span>
      )}
      <CustomLeafActions
        nodeId={leaf.id}
        parentId={leaf.parentId}
        isActive={isActive}
        isHidden={isHidden}
        currentLabel={leaf.label}
        setCustomFilterActive={setCustomFilterActive}
        setCustomFilterHidden={setCustomFilterHidden}
        renameCustom={renameCustom}
        deleteCustom={deleteCustom}
        onEditLeaf={onEditLeaf}
      />
    </div>
  );
}

interface CustomLeafActionsProps {
  nodeId: string;
  parentId: string;
  isActive: boolean;
  isHidden: boolean;
  currentLabel: string;
  setCustomFilterActive: (
    groupId: string,
    entryId: string,
    active: boolean,
  ) => void;
  setCustomFilterHidden: (
    groupId: string,
    entryId: string,
    hidden: boolean,
  ) => void;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  onEditLeaf?: (leafId: string) => void;
}

function CustomLeafActions({
  nodeId,
  parentId,
  isActive,
  isHidden,
  currentLabel,
  setCustomFilterActive,
  setCustomFilterHidden,
  renameCustom,
  deleteCustom,
  onEditLeaf,
}: CustomLeafActionsProps): ReactNode {
  const baseBtn: CSSProperties = {
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
  };

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
      onClick={(e) => e.stopPropagation()}
    >
      {onEditLeaf && (
        <button
          type="button"
          aria-label="Edit filter"
          title="Edit filter"
          onClick={() => onEditLeaf(nodeId)}
          style={{ ...baseBtn, background: "transparent", color: "var(--ff-text-muted)" }}
          data-testid={`custom-leaf-${nodeId}-edit`}
        >
          <PencilIcon size={12} />
        </button>
      )}
      <button
        type="button"
        aria-label={isActive ? "Deactivate filter" : "Activate filter"}
        aria-pressed={isActive}
        title={isActive ? "Deactivate" : "Activate"}
        onClick={() => setCustomFilterActive(parentId, nodeId, !isActive)}
        style={baseBtn}
        data-testid={`custom-leaf-${nodeId}-toggle`}
      >
        <FunnelIcon size={12} />
      </button>
      <VisibilitySwitch
        checked={!isHidden}
        onChange={(visible) => setCustomFilterHidden(parentId, nodeId, !visible)}
        label={`${isHidden ? "Show" : "Hide"} ${currentLabel}`}
        testId={`custom-leaf-${nodeId}-visibility`}
      />
      <OptionsMenu
        nodeId={nodeId}
        currentLabel={currentLabel}
        renameCustom={renameCustom}
        deleteCustom={deleteCustom}
      />
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Three-dots context menu (rename / delete)
// ────────────────────────────────────────────────────────────────────────

interface OptionsMenuProps {
  nodeId: string;
  currentLabel: string;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
  /**
   * Task 20D — when supplied, the menu shows an "Edit" action that
   * invokes this callback. The parent (FiltersPanel) uses it to open
   * the CustomFilterBuilder modal in EDIT mode. We can't tell
   * leaves from folders by id alone here, so the parent passes a
   * nodeId-shaped callback; the caller is responsible for inspecting
   * the tree to know whether `nodeId` is a leaf.
   */
  onEditLeaf?: (leafId: string) => void;
}

function OptionsMenu({
  nodeId,
  currentLabel,
  renameCustom,
  deleteCustom,
  onEditLeaf,
}: OptionsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(currentLabel);

  const triggerStyle: CSSProperties = {
    width: 22,
    height: 22,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "none",
    color: "var(--ff-text-muted)",
    cursor: "pointer",
    padding: 0,
    borderRadius: 4,
  };

  const menuStyle: CSSProperties = {
    position: "absolute",
    top: 24,
    right: 4,
    minWidth: 140,
    background: "var(--ff-bg-elevated)",
    border: "1px solid var(--ff-border)",
    borderRadius: 6,
    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.18)",
    padding: 4,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
  };

  const itemStyle: CSSProperties = {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    textAlign: "left",
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    color: "var(--ff-text-primary)",
    fontSize: 12,
    cursor: "pointer",
    borderRadius: 4,
  };

  function commitRename(): void {
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== currentLabel) {
      renameCustom(nodeId, trimmed);
    }
    setRenaming(false);
    setOpen(false);
  }

  return (
    <span
      style={{ position: "relative", display: "inline-flex" }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="More options"
        title="More options"
        onClick={() => {
          setOpen((prev) => !prev);
          setRenaming(false);
        }}
        style={triggerStyle}
        data-testid={`custom-${nodeId}-options`}
      >
        <DotsIcon size={14} />
      </button>
      {open && (
        <div
          style={menuStyle}
          role="menu"
          data-testid={`custom-${nodeId}-menu`}
          onClick={(e) => e.stopPropagation()}
        >
          {renaming ? (
            <div style={{ padding: 6 }}>
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") {
                    setRenaming(false);
                    setOpen(false);
                  }
                }}
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "4px 6px",
                  fontSize: 12,
                  border: "1px solid var(--ff-border)",
                  borderRadius: 4,
                  background: "var(--ff-bg-app)",
                  color: "var(--ff-text-primary)",
                }}
                autoFocus
                data-testid={`custom-${nodeId}-rename-input`}
              />
              <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
                <button
                  type="button"
                  onClick={commitRename}
                  style={{
                    ...itemStyle,
                    background: "var(--ff-blue-active)",
                    color: "white",
                    textAlign: "center",
                  }}
                  data-testid={`custom-${nodeId}-rename-ok`}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(false);
                    setOpen(false);
                  }}
                  style={{ ...itemStyle, textAlign: "center" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setDraft(currentLabel);
                  setRenaming(true);
                }}
                style={itemStyle}
                data-testid={`custom-${nodeId}-rename`}
              >
                Rename
              </button>
              {onEditLeaf && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onEditLeaf(nodeId);
                  }}
                  style={itemStyle}
                  data-testid={`custom-${nodeId}-edit`}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  deleteCustom(nodeId);
                }}
                style={{ ...itemStyle, color: "var(--ff-danger, #c33)" }}
                data-testid={`custom-${nodeId}-delete`}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Three-dots for folders — only Rename / Delete (Duplicate deferred).
// ────────────────────────────────────────────────────────────────────────

interface CustomGroupActionsProps {
  nodeId: string;
  currentLabel: string;
  renameCustom: (nodeId: string, label: string) => void;
  deleteCustom: (nodeId: string) => void;
}

function CustomGroupActions({
  nodeId,
  currentLabel,
  renameCustom,
  deleteCustom,
}: CustomGroupActionsProps): JSX.Element {
  // Reuse the OptionsMenu component — it works for any node id.
  // Folders don't get the Edit action (only leaves are editable).
  return (
    <OptionsMenu
      nodeId={nodeId}
      currentLabel={currentLabel}
      renameCustom={renameCustom}
      deleteCustom={deleteCustom}
    />
  );
}

// ────────────────────────────────────────────────────────────────────────
// Icons (mirrors AutoFilterSection + FiltersPanel mockup)
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

function DotsIcon({ size = 14 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="19" r="1.6" />
    </svg>
  );
}

function PencilIcon({ size = 14 }: { size?: number }): JSX.Element {
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
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" />
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

// Re-export the UserFilterNode type alias for callers (CustomGroupNode
// already imports it). This avoids TS "unused import" warnings in
// downstream files that need the type but don't touch a node directly.
export type { UserFilterNode };
