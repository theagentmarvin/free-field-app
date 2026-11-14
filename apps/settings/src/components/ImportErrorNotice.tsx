// apps/settings/src/components/ImportErrorNotice.tsx
//
// Wave 64 — the inline error shown under the IFC and PDF sidebar
// blocks. A full browser storage quota (`StorageQuotaExceededError`
// from @ff/data) gets a readable "Browser storage is full" heading
// instead of a raw IndexedDB message, and a user-cancelled IFC import
// reads as a neutral notice, not a failure.

import type { CSSProperties } from "react";

import { isQuotaExceededError } from "@ff/data/db/errors";

export const STORAGE_FULL_TITLE = "Browser storage is full";

function isUserCancel(error: Error): boolean {
  return (
    error.name === "IfcImportAbortedError" &&
    (error as { reason?: unknown }).reason === "aborted"
  );
}

export function ImportErrorNotice({
  error,
  testId,
}: {
  error: Error;
  testId: string;
}): JSX.Element {
  if (isUserCancel(error)) {
    return (
      <div role="status" data-testid={testId} data-kind="cancelled" style={cancelStyle}>
        Import cancelled.
      </div>
    );
  }
  const quota = isQuotaExceededError(error);
  return (
    <div role="alert" data-testid={testId} data-kind={quota ? "quota" : "error"} style={alertStyle}>
      {quota ? <strong style={{ display: "block", marginBottom: 2 }}>{STORAGE_FULL_TITLE}</strong> : null}
      {error.message}
    </div>
  );
}

const alertStyle: CSSProperties = {
  margin: "8px 12px",
  padding: "8px 10px",
  fontSize: 12,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 4,
  lineHeight: 1.4,
  flexShrink: 0,
};

const cancelStyle: CSSProperties = {
  margin: "8px 12px",
  fontSize: 12,
  color: "#475569",
  flexShrink: 0,
};

export default ImportErrorNotice;
