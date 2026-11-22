// src/components/BundleImportButton.tsx
//
// Bundle import in the PDF sidebar. `useBundleImport` holds the state;
// <BundleImportTrigger> is the icon button (boxed like the other "+" buttons,
// with the hidden file input), <BundleImportStatus> shows the progress line
// and the end summary, styled like the bulk PDF import notes.

import { ChangeEvent, CSSProperties, ReactNode, RefObject, useCallback, useRef, useState } from "react";
import { Package } from "iconoir-react";

import { importBundle, summarizeReport, type ImportReport } from "../bundle/importBundle";
import { parseBundle } from "../bundle/parseBundle";
import { ImportErrorNotice } from "./ImportErrorNotice";

export interface UseBundleImportOptions {
  projectId: string | null;
  /** Selected building; null creates one from the bundle's project name. */
  buildingId: string | null;
  /** Called with the report once an import finished. */
  onImported?: (report: ImportReport) => void;
}

export interface BundleImportState {
  inputRef: RefObject<HTMLInputElement>;
  enabled: boolean;
  progress: string | null;
  summary: string[] | null;
  warnings: string[];
  error: Error | null;
  onPicked: (e: ChangeEvent<HTMLInputElement>) => Promise<void>;
  dismissSummary: () => void;
}

export function useBundleImport({ projectId, buildingId, onImported }: UseBundleImportOptions): BundleImportState {
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<string[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const enabled = !!projectId && progress === null;

  const onPicked = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !projectId) return;
      setSummary(null);
      setWarnings([]);
      setError(null);
      setProgress("Reading bundle…");
      try {
        const bundle = await parseBundle(file);
        const report = await importBundle({
          bundle,
          projectId,
          buildingId,
          onProgress: (p) => setProgress(p.message),
        });
        const lines = summarizeReport(report);
        if (report.createdBuilding) lines.unshift(`Created building "${report.buildingName}"`);
        setSummary(lines);
        setWarnings(report.warnings);
        onImported?.(report);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setProgress(null);
      }
    },
    [projectId, buildingId, onImported],
  );

  return {
    inputRef,
    enabled,
    progress,
    summary,
    warnings,
    error,
    onPicked,
    dismissSummary: () => setSummary(null),
  };
}

/** Same boxed 30 x 30 look as the IFC "+" button. */
const iconButtonStyle = (enabled: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  marginLeft: 4,
  padding: 0,
  borderRadius: 4,
  border: "1px solid var(--ff-border)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  cursor: enabled ? "pointer" : "not-allowed",
  opacity: enabled ? 1 : 0.4,
  flexShrink: 0,
});

export function BundleImportTrigger({ state }: { state: BundleImportState }): ReactNode {
  return (
    <>
      <button
        type="button"
        style={iconButtonStyle(state.enabled)}
        disabled={!state.enabled}
        onClick={() => state.inputRef.current?.click()}
        data-testid="bundle-import-button"
        aria-label="Import bundle"
        title="Import bundle"
      >
        <Package width={16} height={16} />
      </button>
      <input
        ref={state.inputRef}
        type="file"
        accept=".ffbundle,.zip"
        onChange={state.onPicked}
        style={{ display: "none" }}
        data-testid="bundle-import-input"
      />
    </>
  );
}

const noteStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  margin: "6px 12px",
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.4,
  color: "var(--ff-text-primary)",
  background: "var(--ff-bg-hover)",
  borderRadius: 6,
};

const dismissStyle: CSSProperties = {
  alignSelf: "flex-end",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  color: "var(--ff-text-muted)",
  fontSize: 14,
  lineHeight: 1,
};

export function BundleImportStatus({ state }: { state: BundleImportState }): ReactNode {
  return (
    <>
      {state.error ? <ImportErrorNotice error={state.error} testId="bundle-import-error" /> : null}
      {state.progress ? (
        <div style={noteStyle} role="status" data-testid="bundle-import-progress">
          {state.progress}
        </div>
      ) : null}
      {state.summary ? (
        <div style={noteStyle} role="status" data-testid="bundle-import-summary">
          {state.summary.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
          {state.warnings.length > 0 ? (
            <details data-testid="bundle-import-warnings">
              <summary>
                {state.warnings.length} warning{state.warnings.length === 1 ? "" : "s"}
              </summary>
              {state.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </details>
          ) : null}
          <button type="button" style={dismissStyle} aria-label="Dismiss" onClick={state.dismissSummary}>
            ×
          </button>
        </div>
      ) : null}
    </>
  );
}
