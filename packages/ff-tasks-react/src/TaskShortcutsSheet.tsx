import { useEffect, useRef } from "react";

import { buttonGhostStyle, tokens } from "./formStyles";
import { SHORTCUT_HELP } from "./useTaskShortcuts";

const { color: c, radius: r, space: s, fontSize: f } = tokens;

export function TaskShortcutsSheet({ onClose }: { onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape" || e.key === "?") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div
      data-testid="shortcuts-scrim"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ position: "fixed", inset: 0, zIndex: 70, background: c.scrim, display: "grid", placeItems: "center", padding: s.s4 }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        data-testid="shortcuts-sheet"
        style={{ width: 440, maxWidth: "100%", background: c.surface, borderRadius: r.lg, boxShadow: tokens.shadow.raised, padding: s.s5, fontFamily: tokens.font, color: c.text }}
      >
        <h3 style={{ margin: `0 0 ${s.s3}px`, fontSize: f.lg }}>Keyboard shortcuts</h3>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: `${s.s2}px ${s.s4}px`, alignItems: "center" }}>
          {SHORTCUT_HELP.map((row) => (
            <div key={row.label} style={{ display: "contents" }}>
              <dt style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {row.keys.map((k) => (
                  <kbd key={k} style={{ border: `1px solid ${c.borderStrong}`, borderBottomWidth: 2, borderRadius: r.sm, background: c.surface2, padding: "2px 7px", fontFamily: "inherit", fontSize: f.sm, fontWeight: 600, whiteSpace: "nowrap" }}>
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd style={{ margin: 0, fontSize: f.md, color: c.text2 }}>{row.label}</dd>
            </div>
          ))}
        </dl>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: s.s4 }}>
          <button type="button" ref={ref} onClick={onClose} style={{ ...buttonGhostStyle, padding: "8px 14px" }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
