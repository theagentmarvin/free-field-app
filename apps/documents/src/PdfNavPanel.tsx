// apps/documents/src/PdfNavPanel.tsx
//
// Task 38 — Outline + thumbnails for the Documents reader.
//
// Two collapsible sections that live in the Documents sidebar,
// BELOW the file list, and only while a PDF is open:
//
//   - Outline    — the PDF's bookmark tree (`doc.getOutline()`),
//                  flattened into one row per entry with its
//                  target page number. Click → `goToPage(n)`.
//   - Thumbnails — one small canvas per page (`doc.numPages`),
//                  rendered lazily (IntersectionObserver) at a
//                  fixed low scale on the panel's OWN canvases.
//                  The viewer's canvas is never touched.
//
// Both sections read the PDF.js document through the <PdfOverlay>
// imperative handle (`getDocument()`), so the app parses the PDF
// exactly once — the panel never loads a second copy.
//
// Document switch: `activePdfVersionId` is the switch key. When
// it changes, the panel drops the previous document and waits for
// the overlay to finish loading the new blob, then re-reads the
// outline and the page count.
//
// Empty-outline path: a PDF without bookmarks renders NO outline
// section at all (no header, no "no outline" placeholder) — the
// panel then simply shows the thumbnails. That reads as
// "this document has no outline", not as a broken widget.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import type { PdfApi } from "@ff/viewer";
import type { PdfOverlayHandle } from "@ff/viewer-react";

/** The loaded PDF.js document (a `PDFDocumentProxy`). */
type PdfDoc = PdfApi["doc"];

/** Thumbnail render scale (PDF.js viewport scale). */
const THUMB_SCALE = 0.15;
/** Hard cap on the rendered thumbnail width, in CSS pixels. */
const THUMB_MAX_WIDTH = 120;
/** How often we look for the overlay's document while it loads. */
const DOC_POLL_MS = 100;
/** Slow safety-net poll for the "current page" highlight. */
const CURRENT_PAGE_POLL_MS = 500;

/**
 * The shape of one PDF.js outline node we care about. PDF.js types
 * the child list as `Array<any>`; this narrows it to the two
 * fields the panel reads (`title` + `dest`) plus the children.
 */
interface OutlineNodeLike {
  title: string;
  /** A named destination (string), an explicit destination array,
   *  or null for items that carry an action instead. */
  dest: string | unknown[] | null;
  items?: OutlineNodeLike[];
}

/** One flattened outline row. */
interface OutlineEntry {
  title: string;
  /** 1-based page number (PDF.js page indexes are 0-based). */
  page: number;
  /** Nesting depth (0 = top level). */
  depth: number;
}

export interface PdfNavPanelProps {
  /**
   * Imperative handle of the mounted <PdfOverlay>. The panel
   * reads the document from it (`getDocument()`) and drives
   * navigation through it (`goToPage` / `getCurrentPage`).
   */
  overlayRef?: RefObject<PdfOverlayHandle> | null;
  /**
   * The active PDF version id. Doubles as the document-switch
   * key: when it changes, the panel drops the previous document
   * and re-reads the new one.
   */
  activePdfVersionId?: string | null;
}

/**
 * Resolve an outline destination to a 1-based page number.
 *
 * A named destination ("chapter1") is resolved through PDF.js's
 * `getDestination`; an explicit destination array is already
 * resolved and is used as-is. Either way the FIRST element of
 * the resolved destination is the page reference, and
 * `getPageIndex` turns it into a 0-based page index.
 *
 * Returns null when the destination cannot be resolved — the
 * caller skips that entry silently.
 */
async function resolveOutlinePage(
  doc: PdfDoc,
  dest: string | unknown[] | null,
): Promise<number | null> {
  if (dest === null || dest === undefined) return null;

  let resolved: unknown[] | null = null;
  if (typeof dest === "string") {
    try {
      resolved = await doc.getDestination(dest);
    } catch {
      return null;
    }
  } else {
    resolved = dest;
  }
  if (!resolved || resolved.length === 0) return null;

  const ref = resolved[0];
  if (ref === null || ref === undefined) return null;

  try {
    if (typeof ref === "number") {
      // Defensive: a few producers hand back a raw page index
      // instead of a page reference.
      return ref + 1;
    }
    const index = await doc.getPageIndex(
      ref as Parameters<PdfDoc["getPageIndex"]>[0],
    );
    return index + 1;
  } catch {
    return null;
  }
}

/**
 * Walk the outline tree depth-first and collect one entry per
 * item that resolves to a page. Items without a resolvable
 * destination (named actions, broken links) are skipped
 * silently — but their children are still walked.
 */
async function flattenOutline(
  doc: PdfDoc,
  nodes: OutlineNodeLike[],
  depth: number,
  out: OutlineEntry[],
): Promise<void> {
  for (const node of nodes) {
    const page = await resolveOutlinePage(doc, node.dest ?? null);
    if (page !== null) {
      out.push({ title: node.title, page, depth });
    }
    const children = node.items ?? [];
    if (children.length > 0) {
      await flattenOutline(doc, children, depth + 1, out);
    }
  }
}

export default function PdfNavPanel({
  overlayRef,
  activePdfVersionId,
}: PdfNavPanelProps): ReactNode {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  // null = "not known yet" (loading); [] = "no outline".
  const [outline, setOutline] = useState<OutlineEntry[] | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [thumbsOpen, setThumbsOpen] = useState(true);

  // ── 1. Acquire the document ─────────────────────────────────
  //
  // The overlay loads the blob asynchronously, so the document
  // isn't available on the panel's first render. Poll the handle
  // until it hands one over; the poll stops as soon as it does
  // (and is torn down on unmount / document switch).
  useEffect(() => {
    if (!activePdfVersionId) {
      setDoc(null);
      return;
    }
    let cancelled = false;
    let timer = 0;
    setDoc(null);
    const poll = (): void => {
      if (cancelled) return;
      const next = overlayRef?.current?.getDocument() ?? null;
      if (next) {
        setDoc(next);
        return;
      }
      timer = window.setTimeout(poll, DOC_POLL_MS);
    };
    timer = window.setTimeout(poll, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activePdfVersionId, overlayRef]);

  // ── 2. Read the outline ─────────────────────────────────────
  useEffect(() => {
    if (!doc) {
      setOutline(null);
      return;
    }
    let cancelled = false;
    setOutline(null);
    (async () => {
      try {
        const raw = (await doc.getOutline()) as OutlineNodeLike[] | null;
        if (cancelled) return;
        if (!raw || raw.length === 0) {
          setOutline([]);
          return;
        }
        const entries: OutlineEntry[] = [];
        await flattenOutline(doc, raw, 0, entries);
        if (!cancelled) setOutline(entries);
      } catch {
        // A broken outline must never break the panel.
        if (!cancelled) setOutline([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  // ── 3. Track the current page ───────────────────────────────
  const readCurrentPage = useCallback((): void => {
    const handle = overlayRef?.current;
    if (!handle) return;
    const next = handle.getCurrentPage();
    setCurrentPage((prev) => (next === prev ? prev : next));
  }, [overlayRef]);

  useEffect(() => {
    if (!doc) return;
    readCurrentPage();
    const handle = overlayRef?.current;
    // The viewer fires a scale-change event on every page jump
    // (the re-render re-applies the CSS transform), so the
    // existing event is enough — no new plumbing in pdfViewer.ts.
    const unsubscribe = handle?.setOnScaleChange(() => readCurrentPage());
    // Safety net: a jump issued while a render is still in flight
    // doesn't fire the event, so re-read slowly as well.
    const timer = window.setInterval(
      readCurrentPage,
      CURRENT_PAGE_POLL_MS,
    );
    return () => {
      unsubscribe?.();
      window.clearInterval(timer);
    };
  }, [doc, overlayRef, readCurrentPage]);

  // ── 4. Navigation ───────────────────────────────────────────
  const handleGoToPage = useCallback(
    (page: number): void => {
      overlayRef?.current?.goToPage(page);
      // `goToPage` updates the viewer synchronously, so the page
      // number is already the new one.
      readCurrentPage();
    },
    [overlayRef, readCurrentPage],
  );

  const pageCount = doc?.numPages ?? 0;
  const hasOutline = outline !== null && outline.length > 0;

  return (
    <div
      className="ff-documents-nav-panel"
      style={panelStyle}
      data-testid="documents-nav-panel"
    >
      {hasOutline ? (
        <section style={sectionStyle} data-testid="documents-nav-outline">
          <button
            type="button"
            data-testid="documents-nav-outline-toggle"
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((v) => !v)}
            style={sectionHeaderStyle}
          >
            <span style={chevronStyle} aria-hidden>
              <ChevronIcon />
            </span>
            <span>Outline</span>
          </button>
          {outlineOpen ? (
            <ul
              style={outlineListStyle}
              data-testid="documents-nav-outline-list"
            >
              {(outline ?? []).map((entry, index) => (
                <li key={`${entry.depth}-${entry.page}-${index}`}>
                  <button
                    type="button"
                    data-testid={`documents-nav-outline-item-${index}`}
                    data-page={entry.page}
                    data-depth={entry.depth}
                    onClick={() => handleGoToPage(entry.page)}
                    style={outlineItemStyle(entry.depth)}
                  >
                    <span style={outlineTitleStyle}>{entry.title}</span>
                    <span style={pageBadgeStyle}>{entry.page}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {doc ? (
        <section style={sectionStyle} data-testid="documents-nav-thumbnails">
          <button
            type="button"
            data-testid="documents-nav-thumbnails-toggle"
            aria-expanded={thumbsOpen}
            onClick={() => setThumbsOpen((v) => !v)}
            style={sectionHeaderStyle}
          >
            <span style={chevronStyle} aria-hidden>
              <ChevronIcon />
            </span>
            <span>Thumbnails</span>
          </button>
          {thumbsOpen ? (
            <div
              style={thumbListStyle}
              data-testid="documents-nav-thumbnails-body"
            >
              {pageCount === 0 ? null : (
                Array.from({ length: pageCount }, (_, index) => (
                  <Thumbnail
                    key={index + 1}
                    doc={doc}
                    pageNumber={index + 1}
                    active={currentPage === index + 1}
                    onSelect={handleGoToPage}
                  />
                ))
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

interface ThumbnailProps {
  doc: PdfDoc;
  /** 1-based page number. */
  pageNumber: number;
  /** True when this is the page the viewer is showing. */
  active: boolean;
  onSelect: (page: number) => void;
}

/**
 * One page thumbnail.
 *
 * The canvas is rendered ONCE, at a low scale, on the panel's own
 * canvas — the viewer's canvas is never touched. Rendering is
 * gated by an IntersectionObserver so a 200-page document doesn't
 * rasterise 200 pages up front. The rendered state is cached: once
 * a page has been drawn it is never drawn again.
 */
function Thumbnail({
  doc,
  pageNumber,
  active,
  onSelect,
}: ThumbnailProps): ReactNode {
  const holderRef = useRef<HTMLSpanElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);

  // Lazy-render gate. Without an IntersectionObserver (jsdom,
  // very old browsers) we render straight away.
  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, []);

  // Draw the page once it becomes visible.
  useEffect(() => {
    if (!visible || rendered) return;
    let cancelled = false;
    // Wave 63 — a thumbnail that scrolls away / unmounts mid-render
    // cancels its PDF.js task, and every page frees its operator list
    // and decoded images (`page.cleanup()`): a long spec book used to
    // keep every rendered page's resources alive.
    let task: { cancel(): void; promise: Promise<unknown> } | null = null;
    let pageRef: { cleanup?: () => unknown } | null = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        pageRef = page as unknown as { cleanup?: () => unknown };
        if (cancelled) {
          pageRef.cleanup?.();
          return;
        }
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(THUMB_SCALE, THUMB_MAX_WIDTH / base.width);
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) return;
        task = page.render({
          canvas,
          canvasContext: context,
          viewport,
        }) as unknown as { cancel(): void; promise: Promise<unknown> };
        await task.promise;
        task = null;
        if (!cancelled) setRendered(true);
      } catch {
        // A failed (or cancelled) thumbnail must never break the panel.
      } finally {
        try {
          pageRef?.cleanup?.();
        } catch {
          /* ignore */
        }
      }
    })();
    return () => {
      cancelled = true;
      try {
        task?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [doc, pageNumber, visible, rendered]);

  return (
    <button
      type="button"
      data-testid={`documents-nav-thumb-${pageNumber}`}
      data-page={pageNumber}
      data-rendered={rendered ? "true" : "false"}
      aria-current={active ? "true" : undefined}
      title={`Page ${pageNumber}`}
      onClick={() => onSelect(pageNumber)}
      style={thumbButtonStyle(active)}
    >
      <span ref={holderRef} style={thumbHolderStyle}>
        <canvas ref={canvasRef} style={thumbCanvasStyle} />
      </span>
      <span style={thumbLabelStyle}>{pageNumber}</span>
    </button>
  );
}

function ChevronIcon(): ReactNode {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M3.5 1.5L7 5L3.5 8.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Styles (inline; same CSS tokens as DocumentsSidebar) ──────

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderTop: "1px solid var(--ff-border)",
  padding: "8px 0 12px",
  background: "var(--ff-bg-app)",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "8px 12px",
  background: "transparent",
  border: "none",
  borderRadius: 0,
  color: "var(--ff-text-muted)",
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: "0.03em",
  textTransform: "uppercase",
  textAlign: "left",
  cursor: "pointer",
};

const chevronStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 12,
  height: 12,
  color: "var(--ff-text-muted)",
  flexShrink: 0,
};

const outlineListStyle: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: 220,
  overflowY: "auto",
};

const outlineItemStyle = (depth: number): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 12px",
  paddingLeft: 12 + depth * 12,
  background: "transparent",
  border: "none",
  color: "var(--ff-text-primary)",
  fontSize: 13,
  textAlign: "left",
  cursor: "pointer",
});

const outlineTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const pageBadgeStyle: CSSProperties = {
  flexShrink: 0,
  minWidth: 20,
  padding: "1px 6px",
  borderRadius: "var(--ff-badge-radius)",
  background: "var(--ff-badge-bg)",
  color: "var(--ff-text-primary)",
  fontSize: 11,
  textAlign: "center",
};

const thumbListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "4px 12px 8px",
  maxHeight: 320,
  overflowY: "auto",
};

const thumbButtonStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 2,
  padding: 2,
  background: "transparent",
  border: active
    ? "2px solid var(--ff-blue-active)"
    : "2px solid transparent",
  borderRadius: 4,
  cursor: "pointer",
});

const thumbHolderStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: THUMB_MAX_WIDTH,
  minHeight: 40,
  background: "var(--ff-bg-panel)",
  border: "1px solid var(--ff-divider)",
  borderRadius: 2,
};

const thumbCanvasStyle: CSSProperties = {
  display: "block",
  maxWidth: "100%",
  height: "auto",
};

const thumbLabelStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--ff-text-muted)",
};
