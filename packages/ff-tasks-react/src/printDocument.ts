import type { TaskEntryView } from "@ff/tasks";

import { statusAccent } from "./formStyles";

import { formatTaskNum, STATUS_LABELS } from "./logic";

/**
 * Task print document (field use: hand a printed punch item to a sub,
 * or "Save as PDF" from the print dialog — the browser IS the PDF
 * engine, so no jsPDF/pdfmake bundle and offline-safe).
 *
 * The builder is a pure string function — fully unit-testable — and
 * the printer side-effect is isolated to `openPrintView`, which renders
 * into a hidden iframe so it works identically from the list sheet,
 * the models viewer and the documents dock, and never fights the
 * host app's stylesheet (or its fixed-position panels).
 *
 * Layout (2026-11-09 redesign, field-report style punch-item print):
 *   - dark brand band (wordmark left, printed-by/date right)
 *   - title block: mono T-number chip + title + status pill
 *   - full-width description, then a 2-col meta grid
 *   - timeline as bordered cards (verb dot + badge, actor · date,
 *     text, 2-col photo grid)
 *   - fixed footer prints on every page
 */

export interface PrintTaskView {
  num: number;
  title: string;
  description: string;
  type: string;
  status: number | null;
  assigneeName: string | null;
  deadline: number | null;
  storeyName: string | null;
  hasBim: boolean;
  pdfPage: number | null;
  createdBy: string | null;
  createdAt: number | null;
  entries: TaskEntryView[];
  /** storagePath → resolved download URL; entries without a URL print as 📷 counts */
  photoUrls?: Record<string, string>;
  /** Day-3 location snapshot thumb (resolved download URL when present). */
  locationThumbUrl?: string | null;
  /** footer attribution */
  printedBy?: string;
  /** ISO-ish timestamp override for deterministic tests */
  printedAt?: string;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || ts <= 0) return "—";
  return new Date(ts).toLocaleString();
}

const VERB_TITLES: Record<string, string> = {
  create: "Created",
  comment: "Comment",
  edit: "Edit",
  assign: "Assign",
  complete: "Submitted for approval",
  reject: "Rejected",
  approve: "Approved",
  followup: "Approved · follow-up",
  discontinue: "Discontinued",
};

/** Accent dot per verb — neutral for chatter, blue for progress,
 *  green for approval, red for rejection. */
const VERB_DOT: Record<string, string> = {
  create: "#6b7280",
  comment: "#6b7280",
  edit: "#6b7280",
  assign: "#2563eb",
  complete: "#2563eb",
  reject: "#dc2626",
  approve: "#16a34a",
  followup: "#16a34a",
  discontinue: "#9ca3af",
};

function statusWord(status: number | null): string {
  if (status === null) return "queued";
  return STATUS_LABELS[status] ?? `status ${status}`;
}

function metaCell(k: string, v: string): string {
  return `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

export function buildTaskPrintHtml(v: PrintTaskView): string {
  const numText = v.num > 0 ? formatTaskNum(v.num) : "queued — not committed yet";
  const accent = v.status !== null ? statusAccent(v.status) : { bg: "#7a828c", ink: "#ffffff" };
  const statusColor = accent.bg;

  const metaCells: string[] = [];
  metaCells.push(metaCell("Type", esc(v.type ? v.type.charAt(0).toUpperCase() + v.type.slice(1) : "Task")));
  metaCells.push(metaCell("Assignee", v.assigneeName ? esc(v.assigneeName) : "—"));
  metaCells.push(metaCell("Deadline", fmtDate(v.deadline)));
  if (v.storeyName) metaCells.push(metaCell("Storey", esc(v.storeyName)));
  const pins: string[] = [];
  if (v.hasBim) pins.push("3D pin");
  if (v.pdfPage !== null) pins.push(`plan pin · page ${v.pdfPage}`);
  const locationBits: string[] = [];
  if (pins.length) locationBits.push(esc(pins.join(" · ")));
  // Day-3: the location snapshot thumb rides the location block.
  if (v.locationThumbUrl) locationBits.push(`<img class="ph" src="${esc(v.locationThumbUrl)}" alt="location snapshot">`);
  if (locationBits.length) metaCells.push(metaCell("Location", locationBits.join(" ")));
  metaCells.push(metaCell("Created by", `${v.createdBy ? esc(v.createdBy) : "—"} · ${fmtDate(v.createdAt)}`));

  const timeline = v.entries
    .map((e) => {
      const dot = VERB_DOT[e.action] ?? "#6b7280";
      const badge =
        e.statusFrom !== null && e.statusTo !== null && e.statusFrom !== e.statusTo
          ? ` <span class="tr">${statusWord(e.statusFrom as number)} → ${statusWord(e.statusTo as number)}</span>`
          : "";
      const state = e.pending
        ? e.failed
          ? ' <span class="warn">⚠ failed — retry pending</span>'
          : ' <span class="warn">⋯ queued — not yet committed</span>'
        : "";
      const photos = (e.photos ?? [])
        .map((p) => {
          const url = v.photoUrls?.[p.storagePath];
          if (url) return `<figure><img class="ph" src="${esc(url)}" alt="">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`;
          return `<span class="phn">📷${p.caption ? ` ${esc(p.caption)}` : ""}</span>`;
        })
        .join("");
      return `<li class="entry">
        <div class="head"><span class="dot" style="background:${dot}"></span><strong class="verb">${esc(VERB_TITLES[e.action] ?? e.action)}</strong>${badge}${state}</div>
        <div class="meta">${e.by ? esc(e.by) : "—"} · ${fmtDate(e.at)}</div>
        ${e.text ? `<div class="x">${esc(e.text).replace(/\n/g, "<br>")}</div>` : ""}
        ${photos ? `<div class="photos">${photos}</div>` : ""}
      </li>`;
    })
    .join("\n");

  const printedAt = v.printedAt ?? new Date().toLocaleString();
  const printedBy = v.printedBy ? ` · ${esc(v.printedBy)}` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(numText)} — ${esc(v.title || "untitled task")}</title>
<style>
  @page { size: A4; margin: 15mm 14mm 24mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font: 12.5px/1.5 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; color: #111827; margin: 0; }

  .brand { display: flex; justify-content: space-between; align-items: center; background: #0f172a; color: #fff; padding: 10px 14px; border-radius: 8px; }
  .brand .logo { font-weight: 800; letter-spacing: .16em; font-size: 13px; }
  .brand .logo small { font-weight: 600; letter-spacing: .04em; color: #94a3b8; margin-left: 8px; font-size: 10.5px; text-transform: uppercase; }
  .brand .when { font-size: 10.5px; color: #cbd5e1; text-align: right; }

  .titleblock { display: flex; align-items: flex-start; gap: 10px; margin: 16px 0 2px; }
  .numchip { font: 700 13px/1 ui-monospace, "SF Mono", Menlo, monospace; background: #eef2ff; color: #3730a3; padding: 7px 9px; border-radius: 6px; white-space: nowrap; margin-top: 2px; }
  h1 { font-size: 20px; margin: 0; line-height: 1.25; flex: 1 1 auto; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; color: ${esc(accent.ink)}; background: ${esc(statusColor)}; white-space: nowrap; margin-top: 4px; }

  .desc { margin: 8px 0 0; color: #374151; }
  .desc .k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; font-weight: 700; margin-bottom: 2px; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; margin: 14px 0 0; padding: 12px 14px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 8px; }
  .cell .k { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #6b7280; font-weight: 700; }
  .cell .v { font-size: 12.5px; color: #111827; margin-top: 1px; }

  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .1em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; margin: 18px 0 10px; break-after: avoid; }
  ol { list-style: none; margin: 0; padding: 0; }
  li.entry { border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; break-inside: avoid; }
  li.entry.pend { opacity: .6; }
  .head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .verb { font-size: 12.5px; }
  .tr { color: #6b7280; font-weight: 400; font-size: 11px; }
  .warn { color: #dc2626; font-size: 10.5px; font-weight: 700; }
  .meta { color: #6b7280; font-size: 10.5px; margin: 2px 0 0 15px; }
  .x { margin: 4px 0 0 15px; }
  .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0 0 15px; }
  figure { margin: 0; }
  figure { break-inside: avoid; }
  img.ph { width: 100%; max-height: 200px; object-fit: contain; background: #f3f4f6; border-radius: 6px; border: 1px solid #e5e7eb; }
  figcaption { font-size: 10px; color: #6b7280; margin-top: 2px; }
  .phn { font-size: 11px; color: #6b7280; margin-right: 8px; }

  footer { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-between; border-top: 1px solid #e5e7eb; padding-top: 5px; color: #6b7280; font-size: 10px; background: #fff; }
</style>
</head>
<body>
  <div class="brand">
    <div class="logo">FREE FIELD<small>Task report</small></div>
    <div class="when">${esc(printedAt)}${printedBy ? ` · ${esc(v.printedBy ?? "")}` : ""}</div>
  </div>
  <div class="titleblock">
    <span class="numchip">${esc(numText)}</span>
    <h1>${esc(v.title || "untitled task")}</h1>
    <span class="pill">${esc(statusWord(v.status))}</span>
  </div>
  ${v.description ? `<div class="desc"><div class="k">Description</div>${esc(v.description).replace(/\n/g, "<br>")}</div>` : ""}
  <div class="grid">${metaCells.join("")}</div>
  <h2>Timeline</h2>
  <ol>
${timeline || '<li class="entry"><div class="head"><span class="dot" style="background:#6b7280"></span><strong class="verb">No entries yet</strong></div></li>'}
  </ol>
  <footer>
    <span>FreeField task report · generated ${esc(printedAt)}${printedBy}</span>
    <span>${esc(numText)}</span>
  </footer>
</body>
</html>`;
}

/**
 * Print via a hidden iframe so the document is self-contained (its own
 * stylesheet, no app chrome, no fixed-position panels leaking through).
 * Kept free of any React/Firebase dependency; every browser API use is
 * optional-chained so a jsdom smoke test can call it harmlessly.
 */
export function openPrintView(html: string): void {
  if (typeof document === "undefined") return;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  const cleanup = () => frame.remove();
  frame.addEventListener("load", () => {
    const win = frame.contentWindow;
    // tiny delay lets already-cached photos decode before the dialog opens
    win?.setTimeout?.(() => {
      try {
        win.focus();
        win.print();
      } catch {
        /* jsdom / print unavailable — iframe removed by the fallback timer */
      }
    }, 60);
  });
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    cleanup();
    return;
  }
  doc.open();
  doc.write(html);
  doc.close();
  // belt & braces: detached iframes linger in some engines after print
  if (typeof window !== "undefined") {
    window.addEventListener("afterprint", cleanup, { once: true });
    window.setTimeout(cleanup, 60_000);
  }
}
