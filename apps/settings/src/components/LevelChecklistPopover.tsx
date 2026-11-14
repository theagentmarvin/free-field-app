// src/components/LevelChecklistPopover.tsx
//
// Modal-style popover for selecting which storeys are "extracted" /
// "mapped" for a building. The list is grouped by IFC filename and
// each row has a checkbox + the storey name + its elevation.
//
// Initial state on open: the effective selection (explicit Dexie
// rows, default-checked for any (building, level) pair without a row).
// The user can toggle individual rows or the whole IFC group. Apply
// persists to Dexie; Cancel discards. The popover does NOT affect
// the viewer yet — that's a future task (FRAGS hide API).
//
// Apply has TWO writes:
//   1. buildingLevelSelection: explicit uncheck rows (Task 3).
//   2. extractedStoreys: the "Mapped" set (Task 4). We pass the full
//      effective set so an unchecked level also has its extracted
//      row removed.
//
// See docs/TASK-3-UI.md "Component breakdown" + "Get Levels popover
// flow" and docs/TASK-4-MAPPED-SECTION.md "Files to modify".

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { IfcFileWithVersions } from "@ff/data/hooks";
import type { StoreyRecord } from "@ff/types";
import {
  buildEffectiveMap,
  isSelected,
  useLevelSelectionActions,
  useLevelSelectionRows,
} from "@hooks/useLevelSelection";
import { getBuildingLevelSelection } from "@ff/data/db/tables/buildingLevelSelection";
import { syncExtractedStoreys } from "@ff/data/db/tables/extractedStoreys";

export interface LevelChecklistPopoverProps {
  open: boolean;
  buildingId: string | null;
  /** Latest-version files in the active building — used for grouping rows. */
  files: IfcFileWithVersions[];
  /** All storeys in the active building, sorted by elevation ascending. */
  storeys: StoreyRecord[];
  onClose: () => void;
}

interface DraftState {
  [levelId: string]: boolean;
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 17, 21, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: "var(--ff-z-modal)",
};

const panelStyle: React.CSSProperties = {
  background: "var(--ff-bg-app)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
  width: 480,
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "calc(100vh - 64px)",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--ff-font-stack)",
  color: "var(--ff-text-primary)",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.18)",
};

const headerStyle: React.CSSProperties = {
  padding: "14px 16px",
  borderBottom: "1px solid var(--ff-border)",
  fontSize: 15,
  fontWeight: 600,
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "8px 0",
};

const groupHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 16px 6px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ff-text-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.04,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 16px",
  fontSize: 14,
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid var(--ff-border)",
};

const baseButtonStyle: React.CSSProperties = {
  padding: "8px 14px",
  fontSize: 14,
  fontWeight: 500,
  borderRadius: 4,
  // Non-shorthand borders — same fix as ConfirmDialog and BuildingCreateDialog.
  borderTop: "1px solid var(--ff-border)",
  borderRight: "1px solid var(--ff-border)",
  borderBottom: "1px solid var(--ff-border)",
  borderLeft: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: "pointer",
  fontFamily: "inherit",
};

const primaryButtonStyle: React.CSSProperties = {
  ...baseButtonStyle,
  background: "var(--ff-blue-active)",
  borderTopColor: "var(--ff-blue-active)",
  borderRightColor: "var(--ff-blue-active)",
  borderBottomColor: "var(--ff-blue-active)",
  borderLeftColor: "var(--ff-blue-active)",
  color: "#ffffff",
};

const checkboxStyle: React.CSSProperties = {
  width: 16,
  height: 16,
  flexShrink: 0,
  accentColor: "var(--ff-blue-active)",
};

const emptyStyle: React.CSSProperties = {
  padding: "32px 16px",
  textAlign: "center",
  color: "var(--ff-text-muted)",
  fontSize: 14,
};

interface GroupedStoreys {
  ifcFileId: string;
  ifcName: string;
  storeys: StoreyRecord[];
}

function groupStoreysByFile(
  files: IfcFileWithVersions[],
  storeys: StoreyRecord[],
): GroupedStoreys[] {
  // Build a lookup: sourceIfcFileId → name. We use sourceIfcFileId
  // (denormalized on StoreyRecord) because that's the link the
  // schema provides without a join.
  const nameByFileId = new Map<string, string>();
  for (const f of files) nameByFileId.set(f.file.id, f.file.name);

  const byFile = new Map<string, StoreyRecord[]>();
  for (const s of storeys) {
    const list = byFile.get(s.sourceIfcFileId) ?? [];
    list.push(s);
    byFile.set(s.sourceIfcFileId, list);
  }
  const groups: GroupedStoreys[] = [];
  for (const [ifcFileId, list] of byFile) {
    // Re-sort each group by elevation (the input is already sorted
    // globally, but a stable per-group order keeps the UI robust to
    // future changes in useStoreys's sort).
    const sorted = [...list].sort((a, b) => {
      if (a.elevation !== b.elevation) return a.elevation - b.elevation;
      return a.name.localeCompare(b.name);
    });
    groups.push({
      ifcFileId,
      ifcName: nameByFileId.get(ifcFileId) ?? "(unknown file)",
      storeys: sorted,
    });
  }
  // Stable order: alphabetical by IFC name.
  groups.sort((a, b) => a.ifcName.localeCompare(b.ifcName));
  return groups;
}

export default function LevelChecklistPopover({
  open,
  buildingId,
  files,
  storeys,
  onClose,
}: LevelChecklistPopoverProps) {
  // Use the live query so the user's "Apply" writes are reflected
  // immediately. We snapshot it into local draft state on open.
  const rows = useLevelSelectionRows(buildingId);
  const actions = useLevelSelectionActions(buildingId ?? "");

  // Local draft state. Keyed by levelId. Initialized from
  // Dexie (with the default-checked invariant) the first time
  // `open` flips true.
  const [draft, setDraft] = useState<DraftState>({});
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (!open) {
      // Reset on close so the next open seeds fresh from Dexie.
      // Bail out when already reset: a fresh `{}` every run re-renders,
      // and with `rows` changing identity that looped forever while
      // the popover was closed (wave 64).
      setInitialized(false);
      setDraft((d) => (Object.keys(d).length === 0 ? d : {}));
      return;
    }
    if (initialized) return;
    if (!buildingId) return;
    let cancelled = false;
    (async () => {
      // Pull the rows directly so the initial draft reflects the
      // current Dexie state synchronously after we resolve the
      // promise. (useLevelSelectionRows would also work, but its
      // first tick returns the empty default and only updates
      // after Dexie resolves; doing a direct read here avoids a
      // flash of "all checked" on re-open.)
      const allRows = await Promise.all(
        storeys.map((s) =>
          getBuildingLevelSelection(buildingId, s.id).then((r) => ({
            levelId: s.id,
            row: r,
          })),
        ),
      );
      if (cancelled) return;
      const next: DraftState = {};
      for (const { levelId, row } of allRows) {
        next[levelId] = isSelected(row);
      }
      setDraft(next);
      setInitialized(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, buildingId, storeys, initialized, rows]);

  // Esc dismisses (treated as Cancel).
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose]);

  const groups = useMemo(
    () => groupStoreysByFile(files, storeys),
    [files, storeys],
  );

  const handleToggle = useCallback((levelId: string) => {
    setDraft((prev) => {
      const wasSelected = prev[levelId] ?? true;
      return { ...prev, [levelId]: !wasSelected };
    });
  }, []);

  const handleGroupToggle = useCallback(
    (group: GroupedStoreys, value: boolean) => {
      setDraft((prev) => {
        const next = { ...prev };
        for (const s of group.storeys) {
          next[s.id] = value;
        }
        return next;
      });
    },
    [],
  );

  const handleApply = useCallback(async () => {
    if (!buildingId) return;
    // 1. buildingLevelSelection diff — only write rows that differ
    //    from the live Dexie state. Default is "selected = true" if
    //    no row exists, so we skip those.
    const updates: Array<{ levelId: string; selected: boolean }> = [];
    for (const [levelId, selected] of Object.entries(draft)) {
      const explicit = rows.find((r) => r.levelId === levelId);
      if (explicit && explicit.selected === selected) continue;
      if (!explicit && selected) continue; // default matches; no-op
      updates.push({ levelId, selected });
    }
    // Atomicity note: `actions.setMany` (buildingLevelSelection) and
    // `syncExtractedStoreys` (extractedStoreys) are each
    // independently transactional. Running them sequentially gives
    // a fire-and-await contract — the popover can `onClose()` once
    // both have resolved. Wrapping BOTH in a single outer
    // `db.transaction("rw", db.buildingLevelSelection,
    // db.extractedStoreys, ...)` would make the pair fully atomic
    // (commit or roll back together), but it would require touching
    // the buildingLevelSelection helpers to accept a tx scope. The
    // Task 4 spec marks the sequential pattern as acceptable; the
    // outer-transaction option is documented as "preferred" but not
    // required. We pick sequential for now to keep the helper APIs
    // stable.
    if (updates.length > 0) {
      await actions.setMany(updates);
    }

    // 2. extractedStoreys sync — pass the full effective set so an
    //    unchecked level also has its extracted row removed. This
    //    implements the "additive" invariant: every level starts
    //    mapped; unchecking un-maps.
    const levelIds = storeys.map((s) => s.id);
    const effective: Record<string, boolean> = buildEffectiveMap(
      rows,
      levelIds,
    );
    // Apply the draft on top of the Dexie-effective map. The draft
    // is the source of truth for what the user wants to commit.
    for (const [levelId, selected] of Object.entries(draft)) {
      effective[levelId] = selected;
    }
    const syncUpdates = storeys.map((s) => ({
      levelId: s.id,
      isExtracted: effective[s.id] ?? true,
    }));
    await syncExtractedStoreys(buildingId, syncUpdates);

    onClose();
  }, [buildingId, draft, rows, storeys, actions, onClose]);

  if (!open) return null;

  return (
    <div
      style={overlayStyle}
      role="dialog"
      aria-modal="true"
      aria-label="Get levels"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={panelStyle}>
        <div style={headerStyle}>Get Levels</div>
        <div style={bodyStyle}>
          {storeys.length === 0 ? (
            <div style={emptyStyle}>
              No storeys loaded yet. Upload an IFC first.
            </div>
          ) : (
            groups.map((group) => {
              const groupSelected = group.storeys.every(
                (s) => draft[s.id] ?? true,
              );
              return (
                <div key={group.ifcFileId} style={{ marginBottom: 8 }}>
                  <div style={groupHeaderStyle}>
                    <input
                      type="checkbox"
                      checked={groupSelected}
                      onChange={(e) =>
                        handleGroupToggle(group, e.target.checked)
                      }
                      style={checkboxStyle}
                      aria-label={`Toggle all levels in ${group.ifcName}`}
                    />
                    <span>{group.ifcName}</span>
                  </div>
                  {group.storeys.map((s) => {
                    const checked = draft[s.id] ?? true;
                    return (
                      <label key={s.id} style={rowStyle}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggle(s.id)}
                          style={checkboxStyle}
                          aria-label={`Toggle ${s.name}`}
                        />
                        <span style={{ flex: 1 }}>{s.name}</span>
                        <span
                          style={{
                            color: "var(--ff-text-muted)",
                            fontSize: 12,
                          }}
                        >
                          z={s.elevation.toFixed(2)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
        <div style={footerStyle}>
          <button
            type="button"
            style={baseButtonStyle}
            onClick={onClose}
            data-testid="level-popover-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            style={primaryButtonStyle}
            onClick={() => void handleApply()}
            disabled={storeys.length === 0}
            data-testid="level-popover-apply"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-export the pure helpers for tests.
export { buildEffectiveMap, groupStoreysByFile };
