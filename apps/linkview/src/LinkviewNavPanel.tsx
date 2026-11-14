// apps/linkview/src/LinkviewNavPanel.tsx
//
// Wave 55 — the Link view's ONE floating panel slot (tenant of the
// tools toolbar <LinkviewNavToolbar>). Replaces the wave-52
// <LinkviewSidebar> (persistent 320px left panel), which the Maintainer
// rejected on 2026-11-08: surface chrome belongs in the tools
// toolbar + panel slot, never in a module sidebar (see
// docs/ux/toolbar-nomenclature.md).
//
// Tenants:
//   "models"  → Models & Levels  (the Models module's own panel)
//   "filters" → Filters          (the Models module's own panel)
//       Both come from @ff/viewer-tools and write the SHARED
//       useModelsToolStore, which the persistent 3D surface (the right
//       pane) applies — hiding a model or applying a filter here is
//       the same action as in Models / Documents, not a copy.
//   "pdfs"  → Mapped PDFs        (BuildingPicker + mapped-PDF rows)
//   "plans" → Model Floor Plans  (BuildingPicker + extracted-storey rows)
//
// Shell: the shared <FrostedNavSlot> (same component as the Models
// NavPanel; phones get the bottom-sheet variant). Row markup, icons,
// testids, and the Dexie hooks are moved VERBATIM from the sidebar
// so list behavior and its test coverage are unchanged.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
} from "react";

import {
  CustomFiltersPanel,
  FrostedNavSlot,
  ModelsLevelsPanel,
} from "@ff/viewer-tools";

// Import BuildingPicker directly (not via the @free-field/models
// barrel) for the same reason documents does: the barrel also
// re-exports ModelsApp, which transitively pulls three.js + the
// IFC viewer and breaks jsdom.
import { useProjectId } from "@ff/auth";
import BuildingPicker from "../../models/src/BuildingPicker";

import type { LinkviewPanelId } from "./LinkviewNavToolbar";
import { useMappedPdfsForBuilding } from "./hooks/useMappedPdfsForBuilding";
import { useExtractedStoreysForBuilding } from "./hooks/useExtractedStoreysForBuilding";

const PANEL_TITLES: Record<LinkviewPanelId, string> = {
  models: "Models & Levels",
  filters: "Filters",
  pdfs: "Mapped PDFs",
  plans: "Model Floor Plans",
};

export interface LinkviewNavPanelProps {
  /** Active tenant (null = slot closed). */
  activePanel: LinkviewPanelId | null;
  /** Close the slot (also wired to Escape by FrostedNavSlot). */
  onClose: () => void;
  /** Phones only — the slot becomes a bottom sheet. */
  mobile?: boolean;
  /** Active building id. Null = "nothing picked yet". */
  buildingId: string | null;
  /** Fired when the user picks a building. Parent owns the state. */
  onBuildingChange: (buildingId: string) => void;
  /** Currently-selected PDF version id, or null. */
  activePdfVersionId: string | null;
  /** Fired when the user clicks a Mapped PDFs row. */
  onActivatePdf: (versionId: string) => void;
  /** Currently-selected storey id, or null. */
  activeStoreyId: string | null;
  /** Fired when the user clicks a Model Floor Plans row. */
  onActivateStorey: (storeyId: string) => void;
  /** Models & Levels: a level row was activated (opens its plan). */
  onOpenLevel?: (levelName: string) => void;
  /** Models & Levels: the open level's name (drives the "open" badge). */
  activeLevelName?: string | null;
}

export default function LinkviewNavPanel({
  activePanel,
  onClose,
  mobile = false,
  buildingId,
  onBuildingChange,
  activePdfVersionId,
  onActivatePdf,
  activeStoreyId,
  onActivateStorey,
  onOpenLevel,
  activeLevelName = null,
}: LinkviewNavPanelProps): ReactNode {
  // Both hooks run regardless of the visible tenant (rules of hooks;
  // FrostedNavSlot keeps children mounted so the lists survive
  // tenant swaps without a refetch).
  const projectId = useProjectId();
  const mappedPdfs = useMappedPdfsForBuilding(projectId ?? null, buildingId);
  const extractedStoreys = useExtractedStoreysForBuilding(buildingId);

  const handleActivateStorey = useCallback(
    (storeyId: string) => onActivateStorey(storeyId),
    [onActivateStorey],
  );

  return (
    <FrostedNavSlot
      open={activePanel !== null}
      title={activePanel ? PANEL_TITLES[activePanel] : ""}
      onClose={onClose}
      mobile={mobile}
      dataPanel={activePanel ?? "none"}
      testId="linkview-nav-panel"
      ariaLabel="Link view panel"
    >
      {activePanel === "models" && (
        <ModelsLevelsPanel
          buildingId={buildingId}
          onOpenLevel={onOpenLevel}
          activeLevelName={activeLevelName}
        />
      )}

      {activePanel === "filters" && <CustomFiltersPanel buildingId={buildingId} />}

      {projectId && (activePanel === "pdfs" || activePanel === "plans") && (
        <BuildingPicker
          activeBuildingId={buildingId}
          projectId={projectId}
          onBuildingChange={onBuildingChange}
        />
      )}

      {activePanel === "pdfs" && (
        <div data-testid="linkview-section-mapped-pdfs">
          {mappedPdfs.length === 0 ? (
            <EmptyHint>
              No PDFs mapped to a level in this building. Run the
              calibration wizard from Settings to create a mapping.
            </EmptyHint>
          ) : (
            <ul style={listStyle} data-testid="linkview-mapped-pdfs-list">
              {mappedPdfs.map((entry) => (
                <PdfRow
                  key={entry.file.id}
                  fileName={entry.file.name}
                  storeyNames={entry.storeyNames}
                  isActive={activePdfVersionId === entry.latestVersion.id}
                  onClick={() => onActivatePdf(entry.latestVersion.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {activePanel === "plans" && (
        <div data-testid="linkview-section-model-floor-plans">
          {extractedStoreys.length === 0 ? (
            <EmptyHint>
              No extracted model floor plans for this building yet.
              Mark levels as extracted in Settings to see them here.
            </EmptyHint>
          ) : (
            <ul
              style={listStyle}
              data-testid="linkview-model-floor-plans-list"
            >
              {extractedStoreys.map((entry) => (
                <StoreyRow
                  key={entry.storey.id}
                  storeyName={entry.storey.name}
                  elevation={entry.storey.elevation}
                  isActive={activeStoreyId === entry.storey.id}
                  onClick={() => handleActivateStorey(entry.storey.id)}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </FrostedNavSlot>
  );
}

// ── Row components (moved verbatim from the wave-52 sidebar) ──────

function EmptyHint({ children }: { children: ReactNode }): ReactNode {
  return (
    <div style={emptyHintStyle} data-testid="linkview-section-empty">
      {children}
    </div>
  );
}

function PdfRow({
  fileName,
  storeyNames,
  isActive,
  onClick,
}: {
  fileName: string;
  storeyNames: string[];
  isActive: boolean;
  onClick: () => void;
}): ReactNode {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLLIElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick],
  );
  return (
    <li
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={{
        ...rowStyle,
        background: isActive ? "var(--ff-bg-hover)" : "var(--ff-bg-app)",
        borderLeft: isActive
          ? "3px solid var(--ff-blue-active)"
          : "3px solid transparent",
      }}
      data-testid={`linkview-pdf-row-${fileName}`}
    >
      <PdfIcon />
      <span style={rowPrimaryStyle}>{fileName}</span>
      <span style={rowSecondaryStyle} title={storeyNames.join(", ")}>
        {storeyNames.join(" · ")}
      </span>
    </li>
  );
}

function StoreyRow({
  storeyName,
  elevation,
  isActive,
  onClick,
}: {
  storeyName: string;
  elevation: number;
  isActive: boolean;
  onClick: () => void;
}): ReactNode {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLLIElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
    [onClick],
  );
  const elevationLabel = `${elevation.toFixed(2)} m`;
  return (
    <li
      role="button"
      tabIndex={0}
      aria-current={isActive ? "true" : undefined}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      style={{
        ...rowStyle,
        background: isActive ? "var(--ff-bg-hover)" : "var(--ff-bg-app)",
        borderLeft: isActive
          ? "3px solid var(--ff-blue-active)"
          : "3px solid transparent",
      }}
      data-testid={`linkview-storey-row-${storeyName}`}
    >
      <StoreyIcon />
      <span style={rowPrimaryStyle}>{storeyName}</span>
      <span style={rowSecondaryStyle}>{elevationLabel}</span>
    </li>
  );
}

function PdfIcon(): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--ff-pdf-icon)" }}
    >
      <path
        d="M4 2.5h8l4 4v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="M12 2.5v4h4" stroke="currentColor" strokeWidth="1.4" />
      <text
        x="10"
        y="14"
        textAnchor="middle"
        fontSize="5"
        fontWeight="700"
        fill="currentColor"
      >
        PDF
      </text>
    </svg>
  );
}

function StoreyIcon(): ReactNode {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ flexShrink: 0, color: "var(--ff-storey-icon, #6b7280)" }}
    >
      <path
        d="M3 16h14M5 16V9l5-4 5 4v7M8 16v-5h4v5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Styles (inline; same CSS tokens as the wave-52 sidebar) ───────

const emptyHintStyle: CSSProperties = {
  padding: "8px 8px 16px",
  fontSize: 13,
  color: "var(--ff-text-muted)",
  lineHeight: 1.5,
};

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  paddingBottom: 8,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  height: "var(--ff-row-height)",
  padding: "0 13px",
  borderBottom: "1px solid var(--ff-divider)",
  cursor: "pointer",
  outline: "none",
  transition: "background 100ms ease",
};

const rowPrimaryStyle: CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  fontSize: 14,
  color: "var(--ff-text-primary)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const rowSecondaryStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  fontSize: 11,
  color: "var(--ff-text-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  textAlign: "right",
};
