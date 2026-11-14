// apps/settings/src/shell/DatabaseUpdateBanner.tsx
//
// Wave 64 — non-blocking banner for @ff/data's database lifecycle.
//
// - "versionchange": another tab opened a newer schema, so this tab's
//   connection was closed. Its data access is gone until it reloads,
//   so the banner offers a Reload button.
// - "blocked": THIS tab's upgrade waits on an older open tab.
//
// While this component is mounted, @ff/data suppresses its built-in
// `confirm()` fallback (any registered listener does).

import { useEffect, useState, type CSSProperties } from "react";

import { onDatabaseLifecycle, type DatabaseLifecycleEvent } from "@ff/data/db/database";

export const DB_UPDATED_MESSAGE = "Database updated in another tab, please reload.";
export const DB_BLOCKED_MESSAGE =
  "Another FreeField tab is using an older version. Close or reload it to finish updating.";

export function DatabaseUpdateBanner({
  reload = () => window.location.reload(),
}: {
  /** Injected for tests; defaults to `window.location.reload()`. */
  reload?: () => void;
}): JSX.Element | null {
  const [event, setEvent] = useState<DatabaseLifecycleEvent["type"] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(
    () =>
      onDatabaseLifecycle((e) => {
        // "versionchange" is the stronger state: never downgrade it.
        setEvent((cur) => (cur === "versionchange" ? cur : e.type));
        setDismissed(false);
      }),
    [],
  );

  if (!event || dismissed) return null;
  const updated = event === "versionchange";
  return (
    <div role="status" aria-live="polite" data-testid="db-update-banner" data-event={event} style={bannerStyle}>
      <span>{updated ? DB_UPDATED_MESSAGE : DB_BLOCKED_MESSAGE}</span>
      {updated ? (
        <button type="button" data-testid="db-update-reload" onClick={reload} style={primaryButtonStyle}>
          Reload
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss"
        data-testid="db-update-dismiss"
        onClick={() => setDismissed(true)}
        style={dismissButtonStyle}
      >
        ×
      </button>
    </div>
  );
}

const bannerStyle: CSSProperties = {
  position: "fixed",
  top: 12,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 10000,
  display: "flex",
  alignItems: "center",
  gap: 10,
  maxWidth: "calc(100vw - 32px)",
  padding: "8px 10px 8px 14px",
  borderRadius: 8,
  border: "1px solid #fcd34d",
  background: "#fffbeb",
  color: "#78350f",
  fontSize: 13,
  fontFamily: "var(--ff-font-stack)",
  boxShadow: "0 4px 16px rgba(15, 23, 42, 0.15)",
};

const primaryButtonStyle: CSSProperties = {
  height: 28,
  padding: "0 12px",
  borderRadius: 6,
  border: "1px solid #b45309",
  background: "#b45309",
  color: "#fff",
  cursor: "pointer",
  fontFamily: "inherit",
  flexShrink: 0,
};

const dismissButtonStyle: CSSProperties = {
  width: 24,
  height: 24,
  border: "none",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  flexShrink: 0,
};

export default DatabaseUpdateBanner;
