import { useState, type CSSProperties } from "react";

import type { TaskEntryView } from "@ff/tasks";

import { tokens } from "./formStyles";
import { transitionBadge, VERB_ICONS, VERB_LABELS } from "./detailLogic";
import { PhotoLightbox } from "./PhotoLightbox";
import { splitMentions, type MentionPerson } from "./mentions";

/**
 * The timeline entry list, extracted so the Activity popup reuses the
 * EXACT rendering the detail sheet used to draw inline (plan §7 screen
 * 3). Keeps the ⋯ queued / ⚠ failed marks + retry affordance and the
 * photo-thumbnail lightbox byte-for-byte in behaviour.
 */

const { color: c, space: s, fontSize: f } = tokens;

const entryStyle: CSSProperties = {
  display: "flex",
  gap: s.s2,
  padding: "7px 0",
  borderBottom: "1px solid #f1f3f4",
};

const iconStyle: CSSProperties = {
  fontSize: 15,
  flex: "0 0 auto",
};

const retryBtnStyle: CSSProperties = {
  marginLeft: 6,
  border: "1px solid #d93025",
  background: "none",
  color: "#d93025",
  borderRadius: 10,
  padding: "1px 8px",
  cursor: "pointer",
  fontSize: 11,
};

export interface TaskTimelineProps {
  entries: TaskEntryView[];
  photoUrls?: Record<string, string>;
  onRetryEntry: (clientGuid: string) => void;
  /** project roster — resolves `@Name` mentions in entry text */
  people?: readonly MentionPerson[];
  /** the signed-in user: mentions of you get the strong highlight */
  currentUid?: string | null;
}

function MentionText({ text, people, currentUid }: { text: string; people: readonly MentionPerson[]; currentUid?: string | null }): JSX.Element {
  return (
    <>
      {splitMentions(text, people).map((part, i) =>
        part.uid ? (
          <span
            key={i}
            className="ff-task-mention"
            data-mention-uid={part.uid}
            style={{
              borderRadius: 4,
              padding: "0 3px",
              fontWeight: 700,
              color: tokens.color.focusRingInk,
              background: part.uid === currentUid ? "rgba(47,111,228,0.22)" : tokens.color.focusRingTint,
            }}
          >
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

export function TaskTimeline({ entries, photoUrls, onRetryEntry, people = [], currentUid }: TaskTimelineProps): JSX.Element {
  const [zoom, setZoom] = useState<string | null>(null);

  return (
    <div>
      {entries.length === 0 && <p style={{ color: c.muted, fontSize: f.md }}>No activity yet.</p>}
      {entries.map((e) => {
        const badge = transitionBadge(e.statusFrom, e.statusTo);
        return (
          <div
            key={e.clientGuid}
            data-testid={`entry-${e.clientGuid}`}
            style={{ ...entryStyle, opacity: e.pending ? 0.55 : 1 }}
          >
            <span aria-hidden style={iconStyle}>{VERB_ICONS[e.action] ?? "•"}</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: f.sm, color: c.text2 }}>
                {e.by} · {new Date(e.at).toLocaleString()}
                {e.pending &&
                  (e.failed ? (
                    <span style={{ color: "#d93025", marginLeft: 6 }}>
                      ⚠ failed
                      <button
                        type="button"
                        data-testid={`entry-retry-${e.clientGuid}`}
                        style={retryBtnStyle}
                        onClick={() => onRetryEntry(e.clientGuid)}
                      >
                        retry
                      </button>
                    </span>
                  ) : (
                    <span style={{ color: c.focusRing, marginLeft: 6 }} title="queued">
                      ⋯
                    </span>
                  ))}
              </div>
              <div style={{ fontSize: f.md }}>
                <span style={{ color: c.text }}>{VERB_LABELS[e.action] ?? e.action}</span>
                {e.text ? (
                  <span style={{ whiteSpace: "pre-wrap" }}>
                    {" — "}
                    <MentionText text={e.text} people={people} currentUid={currentUid} />
                  </span>
                ) : null}
              </div>
              {badge && (
                <div style={{ fontSize: f.xs, color: e.action === "reject" ? "#d93025" : c.text2 }}>
                  {badge}
                </div>
              )}
              {e.photos.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
                  {e.photos.map((ph, i) => {
                    const url = photoUrls?.[ph.storagePath];
                    return url ? (
                      <button
                        key={`${e.clientGuid}-ph${i}`}
                        type="button"
                        data-testid="entry-photo-thumb"
                        aria-label="Open photo"
                        onClick={() => setZoom(url)}
                        style={{ padding: 0, border: "none", background: "none", cursor: "zoom-in" }}
                      >
                        <img
                          src={url}
                          alt={ph.caption ?? "task photo"}
                          style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }}
                        />
                      </button>
                    ) : (
                      <span key={`${e.clientGuid}-ph${i}`} style={{ fontSize: 12, color: c.text2 }}>
                        📷
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {zoom && (
        <PhotoLightbox
          src={zoom}
          srcs={entries.flatMap((e) => e.photos.map((ph) => photoUrls?.[ph.storagePath]).filter((u): u is string => !!u))}
          onClose={() => setZoom(null)}
          testId="photo-lightbox"
          ariaLabel="Photo viewer"
        />
      )}
    </div>
  );
}