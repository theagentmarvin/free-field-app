import { useEffect, useState, type CSSProperties } from "react";

/**
 * Shared photo lightbox: a full-viewport scrim that zooms out on click
 * (or when the close button activates). Used by both the detail
 * attachments grid and the Activity popup's entry photos.
 */
export interface PhotoLightboxProps {
  src: string;
  /** Optional gallery: when it holds >1 url, prev/next + ←/→ keys appear. */
  srcs?: readonly string[];
  onClose: () => void;
  testId?: string;
  ariaLabel?: string;
}

export function PhotoLightbox({ src, srcs, onClose, testId, ariaLabel }: PhotoLightboxProps): JSX.Element {
  const list = srcs && srcs.length > 0 && srcs.includes(src) ? srcs : [src];
  const [idx, setIdx] = useState(() => Math.max(0, list.indexOf(src)));
  const many = list.length > 1;
  const step = (d: number): void => setIdx((i) => (i + d + list.length) % list.length);
  // Escape closes the lightbox only: capture-phase + stopPropagation so the
  // activity popup / detail sheet underneath stay open.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (many && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.stopPropagation();
        step(e.key === "ArrowRight" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, many, list.length]);
  const style: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 70,
    background: "rgba(0,0,0,0.85)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "zoom-out",
  };
  const navBtn = (side: "left" | "right"): CSSProperties => ({
    position: "absolute",
    top: "50%",
    [side]: 16,
    transform: "translateY(-50%)",
    width: 44,
    height: 44,
    borderRadius: 22,
    border: "none",
    background: "rgba(255,255,255,0.18)",
    color: "#fff",
    fontSize: 22,
    cursor: "pointer",
  });
  return (
    <div
      data-testid={testId ?? "photo-lightbox"}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? "Photo viewer"}
      onClick={onClose}
      style={style}
    >
      <img
        src={list[idx]}
        alt="task photo"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "92vw", maxHeight: "86vh", objectFit: "contain", borderRadius: 8, cursor: "default" }}
      />
      <button
        type="button"
        aria-label="Close photo"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        style={{ position: "absolute", top: 16, right: 16, width: 40, height: 40, borderRadius: 20, border: "none", background: "rgba(255,255,255,0.18)", color: "#fff", fontSize: 20, cursor: "pointer" }}
      >
        ✕
      </button>
      {many && (
        <>
          <button type="button" aria-label="Previous photo" data-testid="lightbox-prev" onClick={(e) => { e.stopPropagation(); step(-1); }} style={navBtn("left")}>‹</button>
          <button type="button" aria-label="Next photo" data-testid="lightbox-next" onClick={(e) => { e.stopPropagation(); step(1); }} style={navBtn("right")}>›</button>
          <div style={{ position: "absolute", bottom: 16, left: 0, right: 0, textAlign: "center", color: "#fff", fontSize: 13 }}>
            {idx + 1} / {list.length}
          </div>
        </>
      )}
    </div>
  );
}
