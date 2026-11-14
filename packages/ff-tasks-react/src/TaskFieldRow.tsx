import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import { tokens } from "./formStyles";

/**
 * One labelled row of the detail sheet with inline editing. Read mode
 * shows `display` (+ a ✎ button when `editable`); edit mode renders the
 * caller's editor with Save / Cancel. Enter saves (Ctrl/Cmd+Enter in a
 * multi-line editor), Escape cancels this row only — it stops
 * propagation so the sheet underneath stays open. Validation errors
 * keep the editor open and are announced (`role="alert"`).
 *
 * Saving is optimistic by design: `onSave` hands the value to the host,
 * which enqueues the edit and overlays it immediately; the row returns
 * to read mode at once.
 */

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export interface InlineEditorApi<V> {
  draft: V;
  setDraft: (v: V) => void;
  save: () => void;
  cancel: () => void;
  inputRef: (el: HTMLElement | null) => void;
  /** key handler to spread on the control */
  onKeyDown: (e: KeyboardEvent) => void;
  invalid: boolean;
  errorId: string;
}

export interface TaskFieldRowProps<V> {
  label: string;
  testId: string;
  value: V;
  display: ReactNode;
  editable: boolean;
  /** open the editor on mount (E shortcut) */
  autoStart?: boolean;
  multiline?: boolean;
  last?: boolean;
  isEqual?: (a: V, b: V) => boolean;
  validate?: (draft: V) => string | null;
  onSave: (v: V) => void;
  editor: (api: InlineEditorApi<V>) => ReactNode;
  /** hint under the editor (e.g. "Closed tasks can't be edited") */
  disabledReason?: string;
}

const keyStyle: CSSProperties = {
  flex: "0 0 78px",
  fontSize: f.xs,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
  color: c.muted,
  fontWeight: 700,
  paddingTop: 2,
};

const smallBtn: CSSProperties = {
  border: `1px solid ${c.borderStrong}`,
  background: c.surface,
  color: c.text2,
  borderRadius: r.sm,
  padding: "3px 10px",
  fontSize: f.sm,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

export function TaskFieldRow<V>(p: TaskFieldRowProps<V>): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<V>(p.value);
  const [error, setError] = useState<string | null>(null);
  const ctl = useRef<HTMLElement | null>(null);
  const idBase = useRef(`ff-err-${Math.random().toString(36).slice(2, 8)}`);

  useEffect(() => {
    if (editing) ctl.current?.focus();
  }, [editing]);
  // The doc may still be loading when the sheet mounts (editable flips
  // true a moment later): honour `autoStart` the first time it can open.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (p.autoStart && p.editable && !autoStarted.current) {
      autoStarted.current = true;
      setDraft(p.value);
      setEditing(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.autoStart, p.editable]);
  useEffect(() => {
    if (!p.editable) setEditing(false);
  }, [p.editable]);

  function open(): void {
    setDraft(p.value);
    setError(null);
    setEditing(true);
  }
  function cancel(): void {
    setEditing(false);
    setError(null);
  }
  function save(): void {
    const err = p.validate?.(draft) ?? null;
    if (err) {
      setError(err);
      return;
    }
    const same = (p.isEqual ?? Object.is)(draft, p.value);
    setEditing(false);
    setError(null);
    if (!same) p.onSave(draft);
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      cancel();
    } else if (e.key === "Enter" && (!p.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  }

  return (
    <div
      data-testid={`field-${p.testId}`}
      style={{ display: "flex", alignItems: "flex-start", gap: s.s3, padding: "11px 0", borderBottom: p.last ? undefined : `1px solid ${c.border}` }}
    >
      <span style={keyStyle}>{p.label}</span>
      <div style={{ flex: "1 1 auto", minWidth: 0 }}>
        {editing ? (
          <>
            {p.editor({
              draft,
              setDraft: (v) => {
                setDraft(v);
                if (error) setError(null);
              },
              save,
              cancel,
              inputRef: (el) => {
                ctl.current = el;
              },
              onKeyDown,
              invalid: !!error,
              errorId: `${idBase.current}-e`,
            })}
            {error && (
              <div id={`${idBase.current}-e`} role="alert" data-testid={`field-${p.testId}-error`} style={{ marginTop: 4, fontSize: f.sm, color: c.danger, fontWeight: 600 }}>
                {error}
              </div>
            )}
            <div style={{ display: "flex", gap: s.s2, marginTop: s.s2 }}>
              <button type="button" data-testid={`field-${p.testId}-save`} onClick={save} style={{ ...smallBtn, background: c.primary, color: c.onPrimary, borderColor: c.primary }}>
                Save
              </button>
              <button type="button" data-testid={`field-${p.testId}-cancel`} onClick={cancel} style={smallBtn}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "flex-start", gap: s.s2 }}>
            <div style={{ flex: "1 1 auto", minWidth: 0, fontSize: f.md }}>{p.display}</div>
            {p.editable && (
              <button
                type="button"
                data-testid={`field-${p.testId}-edit`}
                aria-label={`Edit ${p.label.toLowerCase()}`}
                title={`Edit ${p.label.toLowerCase()}`}
                onClick={open}
                style={{ ...smallBtn, flex: "0 0 auto", padding: "2px 8px", border: "1px solid transparent", background: "transparent", color: c.muted }}
              >
                ✎
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export const editorControlStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${c.borderStrong}`,
  borderRadius: r.md,
  padding: "7px 10px",
  fontSize: f.md,
  fontFamily: "inherit",
  background: c.surface,
  color: c.text,
};
