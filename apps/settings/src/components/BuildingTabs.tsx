// src/components/BuildingTabs.tsx
//
// Tab list for the user-defined building containers. Renders one tab
// per building (sorted by creation order from useBuildings) plus a
// trailing `+` button that opens <BuildingCreateDialog>. Each tab
// has a kebab menu (<BuildingTabMenu>) for Rename / Delete and can
// be inline-renamed in place.
//
// Active tab styling matches docs/STYLING.md §5:
//   - Active: text color --ff-blue-active, 2px bottom underline
//   - Inactive: text color --ff-text-muted
//   - Hover (inactive): text → --ff-text-primary
//
// The active tab is owned by the parent (AppShell) so the rest of the
// app can subscribe to the same value. Inline rename / delete
// confirmation are local React state because they only affect the
// tab row, not the rest of the UI.

import {
  FormEvent,
  KeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useBuildingActions, useBuildings } from "@hooks/useBuildings";
import type { BuildingRecord } from "@ff/types";

import BuildingCreateDialog from "./BuildingCreateDialog";
import BuildingTabMenu from "./BuildingTabMenu";
import ConfirmDialog from "./ConfirmDialog";

export interface BuildingTabsProps {
  projectId: string;
  activeBuildingId: string | null;
  onActiveBuildingChange: (id: string | null) => void;
}

const TAB_BAR_HEIGHT = 40;

const tabBarStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  height: TAB_BAR_HEIGHT,
  borderBottom: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  flex: 1,
  minWidth: 0,
  overflowX: "auto",
};

const tabStyle = (active: boolean): React.CSSProperties => ({
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "0 16px",
  height: TAB_BAR_HEIGHT,
  background: "transparent",
  color: active ? "var(--ff-blue-active)" : "var(--ff-text-muted)",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  flexShrink: 0,
  // Non-shorthand borderBottom only. The `border: "none"` shorthand
  // was removed because React 19's style diff warns when a shorthand
  // and a longhand of the same family coexist on the same element
  // (e.g. inactive→active: old has `border: "none"` shorthand, new
  // has `borderBottom: "2px solid ..."` longhand — the shorthand's
  // "all four sides" semantics conflict with the longhand override).
  // No top/right/left borders are set, so removing the shorthand is
  // safe (the underlying <div> has no native border).
  borderBottom: active
    ? "2px solid var(--ff-blue-active)"
    : "2px solid transparent",
  marginBottom: active ? -1 : 0, // sit on the bar's bottom border
});

const kebabStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 20,
  height: 20,
  borderRadius: 3,
  color: "var(--ff-text-muted)",
  cursor: "pointer",
};

const addButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: TAB_BAR_HEIGHT,
  background: "transparent",
  border: "none",
  color: "var(--ff-text-muted)",
  cursor: "pointer",
  flexShrink: 0,
};

const renameInputStyle: React.CSSProperties = {
  width: 130,
  height: 26,
  padding: "0 6px",
  fontSize: 14,
  fontFamily: "inherit",
  border: "1px solid var(--ff-blue-active)",
  borderRadius: 3,
  color: "var(--ff-blue-active)",
  background: "var(--ff-bg-app)",
  outline: "none",
};

function KebabIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="currentColor"
      aria-hidden
    >
      <circle cx="12" cy="5" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="12" cy="19" r="1.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

interface TabRowProps {
  building: BuildingRecord;
  active: boolean;
  onSelect: () => void;
  onRename: (newName: string) => void | Promise<void>;
  onDelete: () => void;
}

function TabRow({
  building,
  active,
  onSelect,
  onRename,
  onDelete,
}: TabRowProps): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(building.name);
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
  const kebabRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the edit draft whenever the row's name changes from the
  // outside (e.g. another tab's rename) so we don't get out of sync.
  useEffect(() => {
    if (!editing) setDraft(building.name);
  }, [building.name, editing]);

  // Auto-focus the rename input when the row enters edit mode.
  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const openMenu = useCallback(() => {
    if (kebabRef.current) {
      setMenuAnchor(kebabRef.current.getBoundingClientRect());
    }
    setMenuOpen(true);
  }, []);

  const startRename = useCallback(() => {
    setDraft(building.name);
    setEditing(true);
  }, [building.name]);

  const commitRename = useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      if (trimmed.length === 0) {
        // Empty rename is a cancel — restore the original name.
        setDraft(building.name);
        setEditing(false);
        return;
      }
      if (trimmed === building.name) {
        setEditing(false);
        return;
      }
      try {
        await onRename(trimmed);
      } finally {
        setEditing(false);
      }
    },
    [building.name, onRename],
  );

  const onInputKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitRename(draft);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setDraft(building.name);
        setEditing(false);
      }
    },
    [commitRename, draft, building.name],
  );

  const onInputBlur = useCallback(() => {
    void commitRename(draft);
  }, [commitRename, draft]);

  const onInputSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      void commitRename(draft);
    },
    [commitRename, draft],
  );

  return (
    <div
      style={tabStyle(active)}
      role="tab"
      aria-selected={active}
      onMouseEnter={(e) => {
        if (!active && !editing) {
          (e.currentTarget as HTMLElement).style.color =
            "var(--ff-text-primary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active && !editing) {
          (e.currentTarget as HTMLElement).style.color =
            "var(--ff-text-muted)";
        }
      }}
    >
      {editing ? (
        <form onSubmit={onInputSubmit} style={{ display: "inline-flex" }}>
          <input
            ref={inputRef}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onInputKey}
            onBlur={onInputBlur}
            maxLength={120}
            aria-label="Rename building"
            style={renameInputStyle}
            onClick={(e) => e.stopPropagation()}
            // Prevent the parent tab's click-to-activate handler.
            onMouseDown={(e) => e.stopPropagation()}
          />
        </form>
      ) : (
        <>
          <span
            onClick={onSelect}
            style={{ cursor: "pointer" }}
            data-building-id={building.id}
          >
            {building.name}
          </span>
          <button
            ref={kebabRef}
            type="button"
            aria-label={`Open menu for ${building.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              if (menuOpen) setMenuOpen(false);
              else openMenu();
            }}
            style={kebabStyle}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color =
                "var(--ff-text-primary)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color =
                "var(--ff-text-muted)";
            }}
          >
            <KebabIcon />
          </button>
          <BuildingTabMenu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            onRename={startRename}
            onDelete={onDelete}
            anchorRect={menuAnchor}
            isActive={active}
          />
        </>
      )}
    </div>
  );
}

export default function BuildingTabs({
  projectId,
  activeBuildingId,
  onActiveBuildingChange,
}: BuildingTabsProps) {
  const buildings = useBuildings(projectId);
  const { create, rename, remove } = useBuildingActions(projectId);

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BuildingRecord | null>(
    null,
  );

  // Auto-select first building if none is active. This satisfies the
  // spec invariant "First building auto-active on app load" without
  // the active flag living in Dexie.
  useEffect(() => {
    if (activeBuildingId !== null) return;
    if (buildings.length === 0) return;
    onActiveBuildingChange(buildings[0].id);
  }, [activeBuildingId, buildings, onActiveBuildingChange]);

  // If the active building was deleted (via this menu or elsewhere),
  // step the active id forward to the first remaining building.
  useEffect(() => {
    if (activeBuildingId === null) return;
    if (!buildings.some((b) => b.id === activeBuildingId)) {
      onActiveBuildingChange(buildings[0]?.id ?? null);
    }
  }, [activeBuildingId, buildings, onActiveBuildingChange]);

  const handleCreate = useCallback(
    async (name: string) => {
      const b = await create(name);
      setCreateOpen(false);
      onActiveBuildingChange(b.id);
    },
    [create, onActiveBuildingChange],
  );

  const handleRename = useCallback(
    async (id: string, name: string) => {
      await rename(id, name);
    },
    [rename],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await remove(id);
  }, [deleteTarget, remove]);

  return (
    <>
      <div
        style={tabBarStyle}
        role="tablist"
        aria-label="Buildings"
        data-testid="building-tabs"
      >
        {buildings.map((b) => (
          <TabRow
            key={b.id}
            building={b}
            active={b.id === activeBuildingId}
            onSelect={() => onActiveBuildingChange(b.id)}
            onRename={(name) => handleRename(b.id, name)}
            onDelete={() => setDeleteTarget(b)}
          />
        ))}
        <button
          type="button"
          style={addButtonStyle}
          onClick={() => setCreateOpen(true)}
          aria-label="Create new building"
          title="Create new building"
          data-testid="building-tabs-add"
        >
          <PlusIcon />
        </button>
      </div>

      <BuildingCreateDialog
        open={createOpen}
        onCreate={handleCreate}
        onCancel={() => setCreateOpen(false)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete building"
        message={
          deleteTarget ? (
            <span>
              Delete <strong>{deleteTarget.name}</strong>? This removes all
              IFCs, versions, storeys, and PDFs (future) under it. This
              cannot be undone.
            </span>
          ) : null
        }
        confirmLabel="Delete"
        danger
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}
