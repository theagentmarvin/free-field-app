import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useLiveQuery } from "dexie-react-hooks";

import { useProjectId } from "@ff/auth";
import { db } from "@ff/data/db/database";
import type { BuildingRecord } from "@ff/types";

/**
 * Building selection dropdown.
 *
 * Two surfaces share ONE live query + ONE listbox implementation:
 *
 *  - <BuildingPicker>     → the classic inline dropdown (trigger +
 *    listbox under it). Still used by the Documents + Linkview
 *    sidebars.
 *  - <BuildingSwitcher>   → the wave-35 module-rail entry: a compact
 *    dropdown that opens to the RIGHT of the 64px rail (the Models
 *    module has no sidebar anymore — the building switcher moved
 *    into the app-level rail).
 *
 * Source of truth is the `buildings` Dexie table written by the
 * Settings module's project-configuration flow — this component is a
 * read-only consumer.
 *
 * Reactive: uses `useLiveQuery` so a building created in Settings
 * while the app is mounted shows up without a route refresh.
 *
 * Controlled: parent owns `activeBuildingId` and reacts to changes
 * via `onBuildingChange`. The picker is a pure presentation +
 * selection layer; it does not own the active state (the same
 * active id feeds the <Viewer> so the 3D viewport stays in sync).
 *
 * Accessibility:
 *  - The trigger is a real <button> with `aria-haspopup="listbox"`,
 *    `aria-expanded`, and `aria-controls` pointing at the list.
 *  - The list is a `role="listbox"`, items are `role="option"` with
 *    `aria-selected`. Arrow keys move the highlight; Enter selects;
 *    Escape closes; Tab moves focus out (closes the popover).
 *  - The trigger and list share an `aria-activedescendant` id for
 *    virtual focus tracking inside the listbox.
 */
export interface BuildingPickerProps {
  /** Currently active building id. Null = nothing selected. */
  activeBuildingId: string | null;
  /** Project whose buildings to show. Defaults to the current project
   * (`useProjectId()`); no project means an empty list. */
  projectId?: string;
  /** Fired when the user picks a different building. */
  onBuildingChange: (buildingId: string) => void;
}

/**
 * The project's buildings, live from Dexie, sorted by creation order
 * (the order they were created in Settings — which is also the order
 * of the Settings <BuildingTabs>).
 *
 * ONE implementation, shared by the inline picker, the rail
 * dropdown and the rail's short-name caption.
 *
 * Wave 65: `projectId` is the caller's current project (the shell
 * passes `useProjectId()` from @ff/auth). No project → no buildings;
 * there is no implicit default any more.
 */
export function useBuildingOptions(
  projectId: string | null | undefined,
): BuildingRecord[] {
  const buildings =
    useLiveQuery(async () => {
      if (!projectId) return [];
      const rows = await db.buildings
        .where("projectId")
        .equals(projectId)
        .toArray();
      rows.sort((a, b) => a.createdAt - b.createdAt);
      return rows;
    }, [projectId]) ?? [];
  return buildings;
}

/** The currently-active building record (null when none is picked). */
export function useActiveBuilding(
  activeBuildingId: string | null,
  projectId: string | null | undefined,
): BuildingRecord | null {
  const buildings = useBuildingOptions(projectId);
  return buildings.find((b) => b.id === activeBuildingId) ?? null;
}

export default function BuildingPicker({
  activeBuildingId,
  projectId: projectIdProp,
  onBuildingChange,
}: BuildingPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  // Live-query the project's buildings. Sorted by createdAt so the
  // dropdown order matches the order they were created in Settings,
  // which matches the order in the Settings <BuildingTabs>.
  const currentProjectId = useProjectId();
  const projectId = projectIdProp ?? currentProjectId;
  const buildings = useBuildingOptions(projectId);

  const activeBuilding =
    buildings.find((b) => b.id === activeBuildingId) ?? null;

  // Keep highlightIndex in range whenever the building list changes
  // or the popover opens. Defaults to the active building so the
  // user can press Enter to re-confirm, then arrow to navigate.
  useEffect(() => {
    if (!open) return;
    const activeIdx = buildings.findIndex((b) => b.id === activeBuildingId);
    setHighlightIndex(activeIdx >= 0 ? activeIdx : 0);
  }, [open, buildings, activeBuildingId]);

  // Outside-click + Escape close. Bound only while open to avoid
  // global listener cost.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        // Return focus to the trigger so keyboard users don't get
        // stranded inside a now-invisible popover.
        const trigger = containerRef.current?.querySelector<HTMLButtonElement>(
          "button[aria-haspopup]",
        );
        trigger?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Scroll the highlighted option into view when navigating with
  // the keyboard inside the listbox. jsdom doesn't implement
  // scrollIntoView; guard so tests run cleanly.
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLLIElement>(
      `[data-idx="${highlightIndex}"]`,
    );
    item?.scrollIntoView?.({ block: "nearest" });
  }, [open, highlightIndex]);

  const selectAt = useCallback(
    (idx: number) => {
      const target = buildings[idx];
      if (!target) return;
      onBuildingChange(target.id);
      setOpen(false);
      // Return focus to the trigger so the next Enter/Tab lands
      // somewhere predictable.
      const trigger = containerRef.current?.querySelector<HTMLButtonElement>(
        "button[aria-haspopup]",
      );
      trigger?.focus();
    },
    [buildings, onBuildingChange],
  );

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // The trigger acts as the entry point; opening it with the
    // arrow keys is a common WAI-ARIA pattern.
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onListKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) =>
        buildings.length === 0 ? 0 : Math.min(i + 1, buildings.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlightIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlightIndex(Math.max(buildings.length - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectAt(highlightIndex);
    }
  }

  return (
    <div ref={containerRef} style={containerStyle}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        style={triggerStyle}
        className="ff-building-picker-trigger"
        data-testid="building-picker-trigger"
        title={activeBuilding?.name ?? "No building selected"}
      >
        <span style={triggerLabelStyle} className="ff-building-picker-label">
          {activeBuilding?.name ?? "Select building…"}
        </span>
        <ChevronIcon rotated={open} />
      </button>

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-activedescendant={
            buildings[highlightIndex]
              ? `${listboxId}-opt-${highlightIndex}`
              : undefined
          }
          onKeyDown={onListKeyDown}
          tabIndex={-1}
          style={listStyle}
          className="ff-building-picker-list"
          data-testid="building-picker-list"
        >
          {buildings.length === 0 ? (
            <li style={emptyStyle} data-testid="building-picker-empty">
              No buildings configured.
              <br />
              Create one in the Settings module.
            </li>
          ) : (
            buildings.map((b, idx) => {
              const selected = b.id === activeBuildingId;
              const highlighted = idx === highlightIndex;
              return (
                <li
                  key={b.id}
                  id={`${listboxId}-opt-${idx}`}
                  role="option"
                  aria-selected={selected}
                  data-idx={idx}
                  data-testid={`building-picker-option-${b.id}`}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onClick={() => selectAt(idx)}
                  style={{
                    ...optionStyle,
                    ...(selected ? optionSelectedStyle : null),
                    ...(highlighted && !selected ? optionHighlightStyle : null),
                  }}
                >
                  <BuildingIcon muted={!selected} />
                  <span style={optionLabelStyle}>{b.name}</span>
                  {selected && <CheckIcon />}
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Wave 35 — the module-rail building switcher.
//
// The Models module lost its sidebar, so the building switcher moved
// into the app-level module rail (apps/settings/src/shell/
// LeftRail.tsx). The rail owns the ICON (with its teal active dot +
// the short-name caption); this component owns the DROPDOWN, which
// reuses the very same live query + listbox content as the inline
// picker above.
//
// The dropdown is positioned by the host (the rail): left 74px /
// top 58px — i.e. it opens to the RIGHT of the 64px rail.
// -----------------------------------------------------------------------------

export interface BuildingSwitcherProps {
  /** Currently active building id. Null = nothing selected. */
  activeBuildingId: string | null;
  /** Project whose buildings to show. Defaults to the current project
   * (`useProjectId()`); no project means an empty list. */
  projectId?: string;
  /** Fired when the user picks a different building. */
  onBuildingChange: (buildingId: string) => void;
  /** Called after a pick (the rail closes the dropdown). */
  onPicked?: () => void;
  /** Called when the user dismisses the dropdown (Escape / outside click). */
  onClose?: () => void;
  /** Host positioning (the rail places it at left 74px / top 58px). */
  style?: CSSProperties;
  /**
   * When true, render ONLY the listbox rows (no wrapper, no
   * "Switch building" title). Used by the wave-39 combined
   * project+building dropdown, which provides its own frosted
   * shell + "Building" header. Default false.
   */
  bare?: boolean;
}

export function BuildingSwitcher({
  activeBuildingId,
  projectId: projectIdProp,
  onBuildingChange,
  onPicked,
  onClose,
  style,
  bare = false,
}: BuildingSwitcherProps): JSX.Element {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const currentProjectId = useProjectId();
  const projectId = projectIdProp ?? currentProjectId;
  const buildings = useBuildingOptions(projectId);

  // Escape closes and returns focus to the rail's trigger (the rail
  // button owns the focus; we just ask it to close).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose?.();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectAt = useCallback(
    (idx: number) => {
      const target = buildings[idx];
      if (!target) return;
      onBuildingChange(target.id);
      onPicked?.();
    },
    [buildings, onBuildingChange, onPicked],
  );

  const listbox = (
    <ul
      ref={listRef}
      id={listboxId}
      role="listbox"
      aria-label="Buildings"
      tabIndex={-1}
      style={switcherListStyle}
      data-testid="building-switcher-list"
    >
      {buildings.length === 0 ? (
        <li style={emptyStyle} data-testid="building-switcher-empty">
          No buildings configured.
          <br />
          Create one in the Settings module.
        </li>
      ) : (
        buildings.map((b, idx) => {
          const selected = b.id === activeBuildingId;
          return (
            <li
              key={b.id}
              id={`${listboxId}-opt-${idx}`}
              role="option"
              aria-selected={selected}
              data-idx={idx}
              data-testid={`building-switcher-option-${b.id}`}
              onClick={() => selectAt(idx)}
              style={{
                ...optionStyle,
                ...(selected ? optionSelectedStyle : null),
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: selected ? "#0e9488" : "var(--ff-text-muted)",
                }}
              />
              <span style={optionLabelStyle}>{b.name}</span>
              {selected && <CheckIcon />}
            </li>
          );
        })
      )}
    </ul>
  );

  if (bare) {
    return listbox;
  }

  return (
    <div
      ref={containerRef}
      style={{ ...switcherStyle, ...style }}
      className="ff-building-switcher"
      data-testid="building-switcher"
      role="group"
      aria-label="Switch building"
    >
      <div style={switcherTitleStyle} data-testid="building-switcher-title">
        Switch building
      </div>
      {listbox}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Styles
// -----------------------------------------------------------------------------

const containerStyle: CSSProperties = {
  position: "relative",
  padding: "6px 12px 8px",
};

// Wave 9 — the trigger is a quiet single-line identity label (name +
// caret), NOT a card. The listbox popover below keeps the full
// listbox/option a11y surface; only the always-visible chrome is
// toned to text so a single-building project reads as "Demo Tower ▾",
// not a persistent dropdown.
const triggerStyle: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: 0,
  background: "transparent",
  border: "none",
  borderRadius: 0,
  fontSize: 13,
  lineHeight: 1.3,
  fontWeight: 500,
  color: "var(--ff-text-secondary)",
  cursor: "pointer",
  fontFamily: "var(--ff-font-stack)",
  textAlign: "left",
};

const triggerLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontWeight: 500,
};

const listStyle: CSSProperties = {
  position: "absolute",
  top: "calc(100% - 1px)",
  left: 12,
  right: 12,
  margin: 0,
  padding: 4,
  listStyle: "none",
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
  zIndex: 10,
  maxHeight: 280,
  overflowY: "auto",
};

/**
 * Wave 35 — the rail dropdown shell. The host positions it (the
 * rail: left 74px / top 58px), so this only owns the box.
 */
const switcherStyle: CSSProperties = {
  width: 230,
  maxHeight: 320,
  display: "flex",
  flexDirection: "column",
  padding: 6,
  borderRadius: 12,
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  boxShadow: "0 8px 32px rgba(16, 24, 40, 0.14)",
  zIndex: 120,
  overflow: "hidden",
};

const switcherTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: "0.11em",
  textTransform: "uppercase",
  color: "var(--ff-text-muted)",
  padding: "8px 9px 4px",
};

const switcherListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  overflowY: "auto",
  minHeight: 0,
};

const optionStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 10px",
  borderRadius: 4,
  fontSize: 13,
  color: "var(--ff-text-primary)",
  cursor: "pointer",
  userSelect: "none",
};

const optionSelectedStyle: CSSProperties = {
  background: "var(--ff-bg-hover)",
  color: "var(--ff-blue-active)",
  fontWeight: 600,
};

const optionHighlightStyle: CSSProperties = {
  background: "var(--ff-bg-panel)",
};

const optionLabelStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const emptyStyle: CSSProperties = {
  padding: "12px 10px",
  fontSize: 12,
  color: "var(--ff-text-muted)",
  textAlign: "center",
  lineHeight: 1.5,
  listStyle: "none",
};

// -----------------------------------------------------------------------------
// Icons — inline SVGs to avoid pulling in a dependency. The shapes
// mirror the ones used in BuildingTabs / IfcListItem.
// -----------------------------------------------------------------------------

export function BuildingIcon({ muted = false }: { muted?: boolean }): JSX.Element {
  const stroke = muted ? "var(--ff-text-muted)" : "currentColor";
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke={stroke}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M3 21V7l9-4 9 4v14" />
      <path d="M9 21v-6h6v6" />
      <path d="M9 11h.01M15 11h.01M9 14h.01M15 14h.01" />
    </svg>
  );
}

function ChevronIcon({ rotated }: { rotated: boolean }): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transition: "transform 120ms ease",
        transform: rotated ? "rotate(180deg)" : "rotate(0deg)",
      }}
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function CheckIcon(): JSX.Element {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--ff-blue-active)" }}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// Avoid an unused-var lint warning while keeping the BuildingRecord
// type available for future expansion (e.g. showing metadata in the
// dropdown footer, like a created-on subline).
export type { BuildingRecord };
