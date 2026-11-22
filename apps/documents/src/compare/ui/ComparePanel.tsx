// apps/documents/src/compare/ui/ComparePanel.tsx
//
// The `compare` tenant body of the Documents floating panel: Base /
// Revision pickers, mode, settings, run + progress, the changes list and
// export. The viewer itself is <CompareViewer> (mounted by the viewer panel).

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";

import type { PdfVersionRecord } from "@ff/types";

import { useModelsToolStore } from "../../../../../packages/ff-viewer-tools/src/modelsToolStore";
import { useDocumentsGroups, type PdfEntryWithFolder } from "../../hooks/useDocumentsGroups";
import { useCompareStore } from "../compareStore";
import { regionsToCsv, downloadBlob } from "../csv";
import { MISALIGNED_MESSAGE, looksMisaligned } from "../hints";
import { defaultRunner } from "../defaultRunner";
import { useAutoRun } from "../useAutoRun";
import { KIND_COLOR, canvasToBlob, renderExportCanvas } from "../viewer/composite";
import type {
  ChangeKind,
  ChangeRegion,
  CompareMode,
  CompareSide,
  RunCompare,
  SensitivityPreset,
} from "../types";

export interface ComparePanelProps {
  /** Engine runner; defaults to the lazily loaded engine. Tests inject a fake. */
  runner?: RunCompare;
  /** Called after "Exit compare" has left compare mode. */
  onExit?: () => void;
  /** Phone layout: the panel is a bottom sheet that covers the lower pane. */
  mobile?: boolean;
  /** Mobile: collapse the panel (e.g. after tapping a change) so the viewer is visible. */
  onCollapse?: () => void;
}

const MODES: { id: CompareMode; label: string }[] = [
  { id: "side-by-side", label: "Side by side" },
  { id: "overlay", label: "Overlay" },
  { id: "changes", label: "Changes" },
];

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
};

const STAGE_LABEL: Record<string, string> = {
  loading: "Loading",
  rendering: "Rendering",
  aligning: "Aligning",
  comparing: "Comparing",
  done: "Done",
};

export function formatVersion(v: Pick<PdfVersionRecord, "versionNumber" | "storedAt">): string {
  const d = new Date(v.storedAt).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `v${v.versionNumber} · ${d}`;
}

function fmtPt(n: number): string {
  return String(Math.round(n));
}

export default function ComparePanel({ runner = defaultRunner, onExit, mobile = false, onCollapse }: ComparePanelProps): ReactNode {
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const groups = useDocumentsGroups(activeBuildingId);
  const rows = groups?.rows ?? [];

  const s = useCompareStore();
  useAutoRun(runner, s.active);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const regions = s.result?.regions ?? [];
  const reviewedCount = regions.filter((r) => s.reviewed.includes(r.id)).length;

  const exportCsv = () => {
    if (!s.result) return;
    const blob = new Blob([regionsToCsv(s.result.regions, s.reviewed)], { type: "text/csv" });
    downloadBlob(blob, "compare-changes.csv");
  };

  const exportPng = async () => {
    if (!s.result) return;
    const canvas = renderExportCanvas(s.result, {
      mode: s.mode,
      style: s.settings.highlightStyle,
      selectedId: s.selectedRegionId,
      overlay: {
        showBase: s.layerVisibility.base,
        showRevision: s.layerVisibility.revision,
        baseOpacity: s.layerOpacity.base,
        revisionOpacity: s.layerOpacity.revision,
        colors: s.overlayColors,
      },
    });
    if (!canvas) return;
    const blob = await canvasToBlob(canvas);
    // Release the (possibly 12 MP) export canvas right away.
    canvas.width = 0;
    canvas.height = 0;
    if (blob) downloadBlob(blob, "compare-view.png");
  };

  const exit = () => {
    s.close();
    onExit?.();
  };

  const running = s.status === "running";
  const canRun = s.base !== null && s.revision !== null && !running;
  const result = s.result;

  return (
    <div style={rootStyle} data-testid="documents-compare-panel">
      <SidePicker
        title="Base"
        testPrefix="base"
        side={s.base}
        rows={rows}
        onChange={s.setBase}
      />
      <div style={swapRowStyle}>
        <button
          type="button"
          style={iconButtonStyle}
          onClick={s.swap}
          title="Swap Base and Revision"
          aria-label="Swap Base and Revision"
          data-testid="documents-compare-swap"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M7 4v14M7 18l-3-3M7 18l3-3M17 20V6M17 6l-3 3M17 6l3 3" />
          </svg>
        </button>
      </div>
      <SidePicker
        title="Revision"
        testPrefix="revision"
        side={s.revision}
        rows={rows}
        onChange={s.setRevision}
      />

      <div style={segStyle} role="group" aria-label="Compare mode" data-testid="documents-compare-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            style={{ ...segBtnStyle, ...(s.mode === m.id ? segBtnActiveStyle : null) }}
            aria-pressed={s.mode === m.id}
            data-testid={`documents-compare-mode-${m.id}`}
            onClick={() => s.setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        style={disclosureStyle}
        aria-expanded={settingsOpen}
        data-testid="documents-compare-settings-toggle"
        onClick={() => setSettingsOpen((o) => !o)}
      >
        <span>{settingsOpen ? "▾" : "▸"}</span> Settings
      </button>
      {settingsOpen ? <SettingsSection /> : null}

      <button
        type="button"
        style={{ ...primaryBtnStyle, opacity: canRun ? 1 : 0.5 }}
        disabled={!canRun}
        data-testid="documents-compare-run"
        onClick={() => void s.run(runner)}
      >
        {result ? "Re-run compare" : "Run compare"}
      </button>

      {running ? (
        <div style={mutedStyle} data-testid="documents-compare-progress" role="status">
          {s.progress
            ? `${STAGE_LABEL[s.progress.stage] ?? s.progress.stage}… ${Math.round(s.progress.fraction * 100)}%`
            : "Starting…"}
        </div>
      ) : null}
      {s.status === "error" ? (
        <div style={errorStyle} data-testid="documents-compare-error" role="alert">
          {s.error}
        </div>
      ) : null}

      {result ? (
        <>
          <Notices />
          <div style={summaryRowStyle}>
            <span data-testid="documents-compare-summary" style={{ fontWeight: 600 }}>
              {regions.length} {regions.length === 1 ? "change" : "changes"} · {reviewedCount} reviewed
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              style={iconButtonStyle}
              onClick={s.prevRegion}
              disabled={regions.length === 0}
              title="Previous change ["
              aria-label="Previous change"
              data-testid="documents-compare-prev"
            >
              ‹
            </button>
            <button
              type="button"
              style={iconButtonStyle}
              onClick={s.nextRegion}
              disabled={regions.length === 0}
              title="Next change ]"
              aria-label="Next change"
              data-testid="documents-compare-next"
            >
              ›
            </button>
          </div>
          <ul style={listStyle} data-testid="documents-compare-list">
            {regions.map((r) => (
              <ChangeRow
                key={r.id}
                region={r}
                selected={s.selectedRegionId === r.id}
                reviewed={s.reviewed.includes(r.id)}
                onSelect={() => {
                  s.selectRegion(r.id);
                  if (mobile) onCollapse?.();
                }}
                onToggle={() => s.toggleReviewed(r.id)}
              />
            ))}
          </ul>
          <div style={exportRowStyle}>
            <button type="button" style={secondaryBtnStyle} onClick={exportCsv} data-testid="documents-compare-export-csv">
              Export CSV
            </button>
            <button type="button" style={secondaryBtnStyle} onClick={() => void exportPng()} data-testid="documents-compare-export-png">
              Export PNG
            </button>
          </div>
        </>
      ) : null}

      <button type="button" style={secondaryBtnStyle} onClick={exit} data-testid="documents-compare-exit">
        Exit compare
      </button>
    </div>
  );
}

// ── Notices ─────────────────────────────────────────────────────

function Notices(): ReactNode {
  const result = useCompareStore((s) => s.result);
  const autoAlign = useCompareStore((s) => s.settings.autoAlign);
  if (!result) return null;
  const notes: { id: string; text: string }[] = [];
  const { x, y } = result.offsetPt;
  if (Math.abs(x) >= 0.05 || Math.abs(y) >= 0.05) {
    notes.push({
      id: "offset",
      text: `${autoAlign ? "Auto-aligned: Revision shifted" : "Revision nudged"} by ${x.toFixed(1)}, ${y.toFixed(1)} pt.`,
    });
  }
  if (Math.abs(result.revisionScale - 1) > 0.001) {
    notes.push({
      id: "scale",
      text: `Revision page size differs; rescaled to ${(result.revisionScale * 100).toFixed(1)}% to match the Base.`,
    });
  }
  if (result.downscaled) {
    notes.push({ id: "downscaled", text: "Large sheet: resolution was lowered to fit the pixel budget." });
  }
  if (result.aspectMismatch) {
    notes.push({
      id: "aspect",
      text: "Page proportions differ — Revision scaled to Base width; results may be unreliable.",
    });
  }
  if (looksMisaligned(result, autoAlign)) {
    notes.push({ id: "misaligned", text: MISALIGNED_MESSAGE });
  }
  if (result.regions.length === 0) {
    notes.push({ id: "none", text: "No differences found." });
  }
  if (notes.length === 0) return null;
  return (
    <div style={noticesStyle} data-testid="documents-compare-notices">
      {notes.map((n) => (
        <div key={n.id} data-testid={`documents-compare-notice-${n.id}`}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

// ── Changes list row ────────────────────────────────────────────

function ChangeRow({
  region,
  selected,
  reviewed,
  onSelect,
  onToggle,
}: {
  region: ChangeRegion;
  selected: boolean;
  reviewed: boolean;
  onSelect: () => void;
  onToggle: () => void;
}): ReactNode {
  return (
    <li
      style={{
        ...changeRowStyle,
        background: selected ? "var(--ff-bg-hover)" : "transparent",
        borderLeft: selected ? "3px solid var(--ff-blue-active)" : "3px solid transparent",
        opacity: reviewed ? 0.6 : 1,
      }}
      data-testid={`documents-compare-row-${region.id}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span style={{ width: 28, color: "var(--ff-text-muted)" }}>#{region.id}</span>
      <span
        style={{ ...chipStyle, background: KIND_COLOR[region.kind] }}
        data-testid={`documents-compare-kind-${region.id}`}
      >
        {KIND_LABEL[region.kind]}
      </span>
      <span style={{ flex: 1, color: "var(--ff-text-muted)", fontSize: 12 }}>
        {fmtPt(region.bbox.w)} × {fmtPt(region.bbox.h)} pt
      </span>
      <input
        type="checkbox"
        checked={reviewed}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
        aria-label={`Mark change ${region.id} reviewed`}
        data-testid={`documents-compare-reviewed-${region.id}`}
      />
    </li>
  );
}

// ── Pickers ─────────────────────────────────────────────────────

function SidePicker({
  title,
  testPrefix,
  side,
  rows,
  onChange,
}: {
  title: string;
  testPrefix: "base" | "revision";
  side: CompareSide | null;
  rows: PdfEntryWithFolder[];
  onChange: (side: CompareSide | null) => void;
}): ReactNode {
  const row = useMemo(() => rows.find((r) => r.file.id === side?.pdfFileId), [rows, side]);
  const versions = row?.versions ?? [];
  const version = versions.find((v) => v.id === side?.pdfVersionId);
  const pageCount = Math.max(1, version?.pageCount ?? 1);

  const pickFile = (fileId: string) => {
    const r = rows.find((x) => x.file.id === fileId);
    const latest = r?.latestVersion ?? r?.versions[r.versions.length - 1];
    if (!r || !latest) return onChange(null);
    onChange({ pdfFileId: r.file.id, pdfVersionId: latest.id, page: 1 });
  };

  const pickVersion = (versionId: string) => {
    if (!side) return;
    const v = versions.find((x) => x.id === versionId);
    onChange({
      ...side,
      pdfVersionId: versionId,
      page: Math.min(side.page, Math.max(1, v?.pageCount ?? 1)),
    });
  };

  const setPage = (raw: string) => {
    if (!side) return;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    onChange({ ...side, page: Math.min(pageCount, Math.max(1, n)) });
  };

  return (
    <fieldset style={pickerStyle} data-testid={`documents-compare-${testPrefix}`}>
      <legend style={legendStyle}>{title}</legend>
      <select
        style={selectStyle}
        value={side?.pdfFileId ?? ""}
        onChange={(e) => pickFile(e.target.value)}
        aria-label={`${title} document`}
        data-testid={`documents-compare-${testPrefix}-doc`}
      >
        {side === null || !row ? <option value="">Select a document</option> : null}
        {rows.map((r) => (
          <option key={r.file.id} value={r.file.id}>
            {r.file.name}
          </option>
        ))}
      </select>
      <div style={pickerRowStyle}>
        <select
          style={{ ...selectStyle, flex: 1 }}
          value={side?.pdfVersionId ?? ""}
          onChange={(e) => pickVersion(e.target.value)}
          disabled={!side || versions.length === 0}
          aria-label={`${title} version`}
          data-testid={`documents-compare-${testPrefix}-version`}
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              {formatVersion(v)}
            </option>
          ))}
        </select>
        <label style={pageLabelStyle}>
          p
          <input
            type="number"
            min={1}
            max={pageCount}
            value={side?.page ?? 1}
            disabled={!side}
            onChange={(e) => setPage(e.target.value)}
            style={{ ...inputStyle, width: 52 }}
            aria-label={`${title} page`}
            data-testid={`documents-compare-${testPrefix}-page`}
          />
          <span style={{ color: "var(--ff-text-muted)" }}>/ {pageCount}</span>
        </label>
      </div>
    </fieldset>
  );
}

// ── Settings ────────────────────────────────────────────────────

const PRESETS: { id: SensitivityPreset; label: string }[] = [
  { id: "vector", label: "Vector drawings" },
  { id: "scanned", label: "Scanned" },
  { id: "fine", label: "Fine detail" },
];

function SettingsSection(): ReactNode {
  const settings = useCompareStore((s) => s.settings);
  const update = useCompareStore((s) => s.updateSettings);
  const colors = useCompareStore((s) => s.overlayColors);
  const setColors = useCompareStore((s) => s.setOverlayColors);

  const num = (raw: string): number => {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  return (
    <div style={settingsStyle} data-testid="documents-compare-settings">
      <label style={settingRowStyle}>
        <span>Sensitivity</span>
        <select
          style={selectStyle}
          value={settings.preset}
          onChange={(e) => update({ preset: e.target.value as SensitivityPreset })}
          data-testid="documents-compare-preset"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label style={settingRowStyle}>
        <span>Resolution</span>
        <select
          style={selectStyle}
          value={String(settings.dpi)}
          onChange={(e) => update({ dpi: e.target.value === "auto" ? "auto" : Number(e.target.value) === 144 ? 144 : 72 })}
          data-testid="documents-compare-dpi"
        >
          <option value="auto">Auto (up to 144 DPI)</option>
          <option value="72">Standard (72 DPI, faster)</option>
          <option value="144">High (144 DPI)</option>
        </select>
      </label>
      <label style={settingRowStyle}>
        <span>Ignore margin (px)</span>
        <input
          type="number"
          min={0}
          style={{ ...inputStyle, width: 64 }}
          value={settings.marginPx}
          onChange={(e) => update({ marginPx: Math.max(0, num(e.target.value)) })}
          data-testid="documents-compare-margin"
        />
      </label>
      <label style={settingRowStyle}>
        <span>Auto-align</span>
        <input
          type="checkbox"
          checked={settings.autoAlign}
          onChange={(e) => update({ autoAlign: e.target.checked })}
          data-testid="documents-compare-autoalign"
        />
      </label>
      <div style={settingRowStyle}>
        <span>Nudge (pt)</span>
        <span style={{ display: "flex", gap: 6 }}>
          <input
            type="number"
            style={{ ...inputStyle, width: 56 }}
            value={settings.nudgePt.x}
            aria-label="Nudge X"
            onChange={(e) => update({ nudgePt: { ...settings.nudgePt, x: num(e.target.value) } })}
            data-testid="documents-compare-nudge-x"
          />
          <input
            type="number"
            style={{ ...inputStyle, width: 56 }}
            value={settings.nudgePt.y}
            aria-label="Nudge Y"
            onChange={(e) => update({ nudgePt: { ...settings.nudgePt, y: num(e.target.value) } })}
            data-testid="documents-compare-nudge-y"
          />
        </span>
      </div>
      <label style={settingRowStyle}>
        <span>Highlight</span>
        <select
          style={selectStyle}
          value={settings.highlightStyle}
          onChange={(e) => update({ highlightStyle: e.target.value === "box" ? "box" : "cloud" })}
          data-testid="documents-compare-highlight"
        >
          <option value="cloud">Cloud</option>
          <option value="box">Box</option>
        </select>
      </label>
      <div style={settingRowStyle}>
        <span>Overlay colours</span>
        <span style={{ display: "flex", gap: 6 }}>
          {(["base", "revision", "shared"] as const).map((k) => (
            <input
              key={k}
              type="color"
              value={colors[k]}
              title={k === "shared" ? "Shared ink" : k === "base" ? "Base" : "Revision"}
              aria-label={`${k} colour`}
              onChange={(e) => setColors({ [k]: e.target.value })}
              style={colorInputStyle}
              data-testid={`documents-compare-color-${k}`}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 4,
  fontSize: 13,
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
};

const pickerStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  margin: 0,
  padding: "6px 10px 10px",
  border: "1px solid var(--ff-border)",
  borderRadius: 8,
  minWidth: 0,
};

const legendStyle: CSSProperties = {
  padding: "0 6px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: "var(--ff-text-muted)",
};

const pickerRowStyle: CSSProperties = { display: "flex", gap: 8, alignItems: "center" };

const pageLabelStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };

const swapRowStyle: CSSProperties = { display: "flex", justifyContent: "center", margin: "-4px 0" };

const selectStyle: CSSProperties = {
  minWidth: 0,
  width: "100%",
  padding: "5px 6px",
  fontSize: 13,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
};

const inputStyle: CSSProperties = {
  padding: "4px 6px",
  fontSize: 13,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
};

const colorInputStyle: CSSProperties = { width: 28, height: 24, padding: 0, border: "1px solid var(--ff-border)", background: "none" };

const iconButtonStyle: CSSProperties = {
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  border: "1px solid var(--ff-border)",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 16,
};

const segStyle: CSSProperties = {
  display: "flex",
  border: "1px solid var(--ff-border)",
  borderRadius: 8,
  overflow: "hidden",
};

const segBtnStyle: CSSProperties = {
  flex: 1,
  padding: "6px 4px",
  fontSize: 12,
  background: "transparent",
  color: "var(--ff-text-primary)",
  border: "none",
  cursor: "pointer",
};

const segBtnActiveStyle: CSSProperties = { background: "var(--ff-blue-active)", color: "#fff", fontWeight: 600 };

const disclosureStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: "2px 0",
  background: "none",
  border: "none",
  color: "var(--ff-text-muted)",
  fontSize: 12,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  cursor: "pointer",
};

const settingsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "8px 10px",
  border: "1px solid var(--ff-divider)",
  borderRadius: 8,
};

const settingRowStyle: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, fontSize: 12 };

const primaryBtnStyle: CSSProperties = {
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  background: "var(--ff-blue-active)",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

const secondaryBtnStyle: CSSProperties = {
  flex: 1,
  padding: "7px 10px",
  fontSize: 13,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  border: "1px solid var(--ff-border)",
  borderRadius: 8,
  cursor: "pointer",
};

const mutedStyle: CSSProperties = { fontSize: 12, color: "var(--ff-text-muted)" };

const errorStyle: CSSProperties = {
  padding: "8px 10px",
  fontSize: 12,
  color: "#e5484d",
  border: "1px solid #e5484d",
  borderRadius: 8,
};

const noticesStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 10px",
  fontSize: 12,
  lineHeight: 1.4,
  color: "var(--ff-text-muted)",
  background: "var(--ff-bg-hover)",
  borderRadius: 8,
};

const summaryRowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const listStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: 260,
  overflowY: "auto",
  border: "1px solid var(--ff-divider)",
  borderRadius: 8,
};

const changeRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  borderBottom: "1px solid var(--ff-divider)",
  cursor: "pointer",
  fontSize: 13,
};

const chipStyle: CSSProperties = {
  padding: "1px 8px",
  borderRadius: 10,
  fontSize: 11,
  fontWeight: 600,
  color: "#fff",
};

const exportRowStyle: CSSProperties = { display: "flex", gap: 8 };
