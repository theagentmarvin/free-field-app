import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { TaskEntryView } from "@ff/tasks";

import { formatTaskNum } from "./logic";
import { activeMention, insertMention, mentionCandidates, type MentionPerson } from "./mentions";
import { TaskTimeline } from "./TaskTimeline";
import {
  buttonPrimaryStyle,
  controlStyle,
  iconButtonSmallStyle,
  tokens,
} from "./formStyles";

/**
 * Activity popup (validated v2 artboard C): an overlay sheet riding on
 * the dimmed detail. Timeline entries + the comment composer live HERE
 * (the detail bottom bar keeps only state-machine verbs). Closes on
 * scrim / ✕ / Escape; role="dialog" + a focus trap; the detail body
 * never unmounts so its scroll position is preserved.
 */

const { color: c, radius: r, space: s, fontSize: f, shadow } = tokens;

export interface TaskActivityPopupProps {
  num: number;
  entries: TaskEntryView[];
  photoUrls?: Record<string, string>;
  onRetryEntry: (clientGuid: string) => void;
  onComment: (text: string) => void;
  onClose: () => void;
  /** project roster: powers @mention autocomplete + timeline rendering */
  people?: readonly MentionPerson[];
  currentUid?: string | null;
}

export function TaskActivityPopup({
  num,
  entries,
  photoUrls,
  onRetryEntry,
  onComment,
  onClose,
  people = [],
  currentUid,
}: TaskActivityPopupProps): JSX.Element {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [listDismissed, setListDismissed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const mention = activeMention(draft, caret);
  const candidates = mention && !listDismissed ? mentionCandidates(people, mention.query) : [];
  const listOpen = candidates.length > 0;

  function choose(person: MentionPerson): void {
    if (!mention) return;
    const next = insertMention(draft, caret, mention, person);
    setDraft(next.text);
    setCaret(next.caret);
    setPick(0);
    pendingCaret.current = next.caret;
  }
  // Apply the caret in the same commit as the new value (a rAF here would
  // race with fast typing and drop the cursor mid-word).
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null || !inputRef.current) return;
    pendingCaret.current = null;
    inputRef.current.focus();
    inputRef.current.setSelectionRange(at, at);
  });
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // `onClose` is read through a ref: the parent re-renders (and hands a
  // new callback) whenever the doc changes, and re-running this effect
  // would steal focus back from the comment box mid-typing.
  const closeRef2 = useRef(onClose);
  closeRef2.current = onClose;
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        closeRef2.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Simple focus trap: wrap Escape in the composer, re-focus close on exit.
  function send(): void {
    const text = draft.trim();
    if (!text) return;
    onComment(text);
    setDraft("");
  }

  const title = num > 0 ? formatTaskNum(num) : "queued";

  return (
    <>
      <div
        data-testid="activity-scrim"
        aria-hidden
        onClick={onClose}
        style={{ position: "absolute", inset: 0, background: c.scrim, zIndex: 5 }}
      />
      <div
        role="dialog"
        aria-label="Activity timeline"
        data-testid="activity-popup"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          background: c.surface,
          borderRadius: `${r.lg}px ${r.lg}px 0 0`,
          boxShadow: shadow.popup,
          zIndex: 6,
          padding: `${s.s2}px ${s.s4}px ${s.s4}px`,
          display: "flex",
          flexDirection: "column",
          gap: s.s2,
          maxHeight: "78%",
          overflow: "hidden",
        }}
      >
        <div style={{ width: 40, height: 4, borderRadius: r.pill, background: c.borderStrong, margin: "4px auto", flex: "0 0 auto" }} />
        <div style={{ display: "flex", alignItems: "center", gap: s.s2, flex: "0 0 auto" }}>
          <span data-testid="activity-title" style={{ flex: "1 1 auto", fontWeight: 700, fontSize: f.base }}>
            Activity · {title}
          </span>
          <button type="button" ref={closeRef} aria-label="Close activity" onClick={onClose} style={iconButtonSmallStyle}>
            ✕
          </button>
        </div>
        <div data-testid="activity-entries" style={{ flex: "1 1 auto", overflow: "auto", minHeight: 0 }}>
          <TaskTimeline entries={entries} photoUrls={photoUrls} onRetryEntry={onRetryEntry} people={people} currentUid={currentUid} />
        </div>
        <div style={{ position: "relative", display: "flex", gap: s.s2, alignItems: "center", borderTop: `1px solid ${c.border}`, paddingTop: s.s2, flex: "0 0 auto" }}>
          {listOpen && (
            <ul
              role="listbox"
              aria-label="Mention a project member"
              data-testid="mention-list"
              style={{ position: "absolute", left: 0, bottom: "100%", margin: 0, marginBottom: 4, padding: 4, listStyle: "none", minWidth: 220, maxWidth: "100%", background: c.surface, border: `1px solid ${c.border}`, borderRadius: r.md, boxShadow: shadow.raised, zIndex: 8 }}
            >
              {candidates.map((p, i) => (
                <li
                  key={p.uid}
                  role="option"
                  aria-selected={i === pick}
                  data-testid={`mention-option-${p.uid}`}
                  onMouseDown={(ev) => {
                    ev.preventDefault();
                    choose(p);
                  }}
                  onMouseEnter={() => setPick(i)}
                  style={{ padding: "6px 10px", borderRadius: r.sm, cursor: "pointer", fontSize: f.md, background: i === pick ? c.focusRingTint : "transparent", color: i === pick ? c.focusRingInk : c.text, fontWeight: i === pick ? 700 : 500 }}
                >
                  @{p.name}
                </li>
              ))}
            </ul>
          )}
          <input
            ref={inputRef}
            data-testid="activity-comment-input"
            value={draft}
            onChange={(ev) => {
              setDraft(ev.target.value);
              setCaret(ev.target.selectionStart ?? ev.target.value.length);
              setPick(0);
              setListDismissed(false);
            }}
            onSelect={(ev) => setCaret((ev.target as HTMLInputElement).selectionStart ?? 0)}
            role={people.length > 0 ? "combobox" : undefined}
            aria-expanded={people.length > 0 ? listOpen : undefined}
            aria-autocomplete={people.length > 0 ? "list" : undefined}
            onKeyDown={(ev) => {
              if (listOpen) {
                if (ev.key === "ArrowDown") {
                  ev.preventDefault();
                  setPick((p) => (p + 1) % candidates.length);
                  return;
                }
                if (ev.key === "ArrowUp") {
                  ev.preventDefault();
                  setPick((p) => (p - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (ev.key === "Enter" || ev.key === "Tab") {
                  ev.preventDefault();
                  const chosen = candidates[pick];
                  if (chosen) choose(chosen);
                  return;
                }
                if (ev.key === "Escape") {
                  ev.stopPropagation();
                  setListDismissed(true);
                  return;
                }
              }
              if (ev.key === "Enter") send();
            }}
            placeholder={people.length > 0 ? "Add a comment… type @ to mention" : "Add a comment…"}
            aria-label="Add a comment"
            style={{ ...controlStyle, flex: "1 1 auto", minHeight: 42, fontSize: f.md }}
          />
          <button
            type="button"
            data-testid="activity-comment-send"
            disabled={!draft.trim()}
            onClick={send}
            style={{ ...buttonPrimaryStyle, minHeight: 42, fontSize: f.md, opacity: draft.trim() ? 1 : 0.5, cursor: draft.trim() ? "pointer" : "not-allowed" }}
          >
            💬 Send
          </button>
        </div>
      </div>
    </>
  );
}