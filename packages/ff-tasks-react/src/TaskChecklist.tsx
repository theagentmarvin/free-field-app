import { useState } from "react";

import { MAX_CHECKLIST_ITEMS, MAX_CHECKLIST_TEXT, type ChecklistItem } from "@ff/tasks";

import { tokens } from "./formStyles";
import { ChecklistProgress } from "./TaskChips";

/**
 * Configurable checklist (sub-items) for a task. Every change hands the
 * FULL next list to the host (one edit entry per change, optimistic).
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export function newChecklistId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

export function TaskChecklist({
  items,
  editable,
  onChange,
}: {
  items: readonly ChecklistItem[];
  editable: boolean;
  onChange: (next: ChecklistItem[]) => void;
}): JSX.Element {
  const [text, setText] = useState("");

  function add(): void {
    const t = text.trim().slice(0, MAX_CHECKLIST_TEXT);
    if (!t || items.length >= MAX_CHECKLIST_ITEMS) return;
    onChange([...items, { id: newChecklistId(), text: t, done: false }]);
    setText("");
  }

  return (
    <div data-testid="detail-checklist">
      <div style={{ marginBottom: s.s2 }}>
        <ChecklistProgress items={items} wide />
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map((it) => (
          <li key={it.id} style={{ display: "flex", alignItems: "center", gap: s.s2, padding: "4px 0" }}>
            <input
              type="checkbox"
              id={`cl-${it.id}`}
              data-testid={`checklist-item-${it.id}`}
              checked={it.done}
              disabled={!editable}
              onChange={() => onChange(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
              style={{ width: 16, height: 16, accentColor: c.focusRing, cursor: editable ? "pointer" : "default" }}
            />
            <label
              htmlFor={`cl-${it.id}`}
              style={{ flex: "1 1 auto", minWidth: 0, fontSize: f.md, textDecoration: it.done ? "line-through" : undefined, color: it.done ? c.muted : c.text, wordBreak: "break-word" }}
            >
              {it.text}
            </label>
            {editable && (
              <button
                type="button"
                aria-label={`Remove ${it.text}`}
                data-testid={`checklist-remove-${it.id}`}
                onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                style={{ border: "none", background: "transparent", color: c.muted, cursor: "pointer", fontSize: f.base, padding: "0 4px" }}
              >
                ×
              </button>
            )}
          </li>
        ))}
        {items.length === 0 && !editable && <li style={{ color: c.muted, fontSize: f.md }}>No checklist items.</li>}
      </ul>
      {editable && (
        <div style={{ display: "flex", gap: s.s2, marginTop: s.s2 }}>
          <input
            data-testid="checklist-new"
            aria-label="New checklist item"
            value={text}
            maxLength={MAX_CHECKLIST_TEXT}
            placeholder={items.length >= MAX_CHECKLIST_ITEMS ? "Checklist is full" : "Add an item…"}
            disabled={items.length >= MAX_CHECKLIST_ITEMS}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            style={{ flex: "1 1 auto", border: `1px solid ${c.borderStrong}`, borderRadius: r.md, padding: "6px 10px", fontSize: f.md, fontFamily: "inherit" }}
          />
          <button
            type="button"
            data-testid="checklist-add"
            disabled={!text.trim()}
            onClick={add}
            style={{ border: `1px solid ${c.borderStrong}`, borderRadius: r.md, background: c.surface, padding: "6px 12px", fontWeight: 700, fontSize: f.md, cursor: text.trim() ? "pointer" : "not-allowed", opacity: text.trim() ? 1 : 0.5, fontFamily: "inherit" }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
