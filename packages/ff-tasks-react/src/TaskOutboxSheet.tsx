import type { CSSProperties } from "react";

import { outboxSheetRows } from "@ff/tasks";
import type { OutboxRecord } from "@ff/types";

import { VERB_ICONS } from "./detailLogic";

/**
 * Outbox management sheet (plan §7 screen 4): the queued/sending/
 * failed rows of the local outbox, with retry-now and delete. Opened
 * from the "⇅ N queued" chip in the Tasks header — the same rows the
 * list overlays inline, shown here in full detail.
 */

export interface TaskOutboxSheetProps {
  /** raw Dexie outbox rows — the sheet filters/sorts via ff-tasks */
  rows: OutboxRecord[];
  onRetry: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const STATE_LABEL: Record<string, { text: string; color: string }> = {
  added: { text: "⋯ queued", color: "#1a73e8" },
  sending: { text: "⇅ sending", color: "#5f6368" },
  failed: { text: "⚠ failed", color: "#d93025" },
};

export function TaskOutboxSheet(p: TaskOutboxSheetProps): JSX.Element {
  const rows = outboxSheetRows(p.rows);
  return (
    <aside
      role="dialog"
      aria-label="Outbox"
      className="ff-task-outbox"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(420px, 100vw)",
        background: "#fff",
        borderLeft: "1px solid #ddd",
        zIndex: 46,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #eee" }}>
        <strong style={{ fontSize: 15 }}>Outbox ({rows.length})</strong>
        <button type="button" aria-label="Close" onClick={p.onClose} style={{ border: "none", background: "none", cursor: "pointer", fontSize: 16 }}>
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 14px" }}>
        {rows.length === 0 && (
          <p style={{ color: "#9aa0a6", fontSize: 13 }} data-testid="outbox-empty">
            Nothing queued — everything is committed.
          </p>
        )}
        {rows.map((row) => {
          const payload = row.payload as unknown as {
            verb?: string;
            title?: string;
            taskId?: string;
          };
          const st = STATE_LABEL[row.state] ?? { text: row.state, color: "#5f6368" };
          return (
            <div
              key={row.id}
              data-testid={`outbox-row-${row.id}`}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: "1px solid #f1f3f4" }}
            >
              <span aria-hidden style={{ fontSize: 15 }}>{VERB_ICONS[payload.verb as keyof typeof VERB_ICONS] ?? "•"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13 }}>
                  <strong>{payload.title ?? "(untitled)"}</strong>
                  <span style={{ color: "#5f6368" }}> · {payload.verb}</span>
                </div>
                <div style={{ fontSize: 12 }}>
                  <span style={{ color: st.color }}>{st.text}</span>
                  {row.attempts > 0 && <span style={{ color: "#5f6368" }}> · {row.attempts} attempt{row.attempts === 1 ? "" : "s"}</span>}
                </div>
                {row.state === "failed" && row.lastError && (
                  <div style={{ fontSize: 11, color: "#d93025", wordBreak: "break-word" }}>{row.lastError}</div>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {row.state === "failed" && (
                  <button
                    type="button"
                    data-testid={`outbox-retry-${row.id}`}
                    style={btn}
                    onClick={() => p.onRetry(row.id)}
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  data-testid={`outbox-delete-${row.id}`}
                  style={{ ...btn, borderColor: "#d93025", color: "#d93025" }}
                  onClick={() => p.onDelete(row.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

const btn: CSSProperties = {
  border: "1px solid #1a73e8",
  background: "none",
  color: "#1a73e8",
  borderRadius: 6,
  padding: "2px 10px",
  cursor: "pointer",
  fontSize: 12,
};
