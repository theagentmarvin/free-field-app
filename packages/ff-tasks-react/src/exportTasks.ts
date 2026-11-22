import { checklistProgress, isDualThumbLocation, normalizeChecklist, priorityOf, PRIORITY_LABELS } from "@ff/tasks";

import { statusAccent } from "./formStyles";
import { deadlineSignal, formatTaskNum, STATUS_LABELS } from "./logic";
import { esc } from "./printDocument";
import type { TaskTableRow } from "./tableColumns";

/**
 * Export of the CURRENT filtered view: CSV (spreadsheet round-trip) and
 * a multi-task PDF report (print view). Pure string builders — the
 * download/print side effects are isolated at the bottom.
 */

export const CSV_HEADERS = [
  "Number",
  "Title",
  "Description",
  "Type",
  "Status",
  "Priority",
  "Assignee",
  "Building",
  "Level",
  "Deadline",
  "Due signal",
  "Checklist",
  "Created by",
  "Created",
  "Updated",
  "Photos",
] as const;

const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC-4180 quoting, plus a leading `'` on cells a spreadsheet would
 *  evaluate as a formula (CSV injection guard). */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (FORMULA_START.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isoDate(ts: number | null | undefined): string {
  if (typeof ts !== "number" || ts <= 0) return "";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type Extra = TaskTableRow & { description?: string; priority?: string | null; checklist?: unknown };

export function buildCsv(rows: readonly TaskTableRow[], now: number): string {
  const lines: string[] = [CSV_HEADERS.map(csvCell).join(",")];
  for (const r of rows as readonly Extra[]) {
    const cl = checklistProgress(normalizeChecklist(r.checklist));
    lines.push(
      [
        formatTaskNum(r.num),
        r.title,
        r.description ?? "",
        r.type ?? "",
        STATUS_LABELS[r.status] ?? r.status,
        PRIORITY_LABELS[priorityOf(r.priority)],
        r.assigneeName ?? "",
        r.buildingName ?? r.buildingId ?? "",
        r.storeyName ?? "",
        isoDate(r.deadline),
        deadlineSignal(r.deadline, r.status, now) ?? "",
        cl.total > 0 ? `${cl.done}/${cl.total}` : "",
        r.createdBy ?? "",
        isoDate(r.createdAt),
        isoDate(r.updatedAt),
        r.photos?.length ?? 0,
      ]
        .map(csvCell)
        .join(",")
    );
  }
  // BOM so Excel opens UTF-8 (accents in names) correctly.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function exportFileName(prefix: string, ext: string, at: number = Date.now()): string {
  return `${prefix}-${isoDate(at)}.${ext}`;
}

/** Browser download of a text blob. No-op without a DOM. */
export function downloadText(name: string, text: string, mime = "text/csv;charset=utf-8"): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ── multi-task report ───────────────────────────────────────────────────

export interface ReportTask {
  row: TaskTableRow;
  /** resolved display URLs (best effort) */
  photoUrls: string[];
  locationThumbUrl: string | null;
  /** LinkView dual location: resolved plan snapshot URL (printed before the 3D one) */
  locationThumb2dUrl?: string | null;
}

export interface ReportMeta {
  projectName?: string | null;
  filterNote?: string;
  printedBy?: string;
  printedAt?: string;
  now: number;
  /** total rows in the view when the report is truncated */
  totalInView?: number;
}

export const REPORT_MAX_TASKS = 200;
export const REPORT_MAX_PHOTOS = 4;

export function buildTasksReportHtml(items: readonly ReportTask[], meta: ReportMeta): string {
  const printedAt = meta.printedAt ?? new Date().toLocaleString();
  const cards = items
    .map(({ row, photoUrls, locationThumbUrl, locationThumb2dUrl }) => {
      const r = row as Extra;
      const accent = statusAccent(r.status);
      const sig = deadlineSignal(r.deadline, r.status, meta.now);
      const cl = checklistProgress(normalizeChecklist(r.checklist));
      const bits: string[] = [];
      const cell = (k: string, v: string) => `<div class="cell"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
      bits.push(cell("Type", esc(r.type ?? "—")));
      bits.push(cell("Priority", esc(PRIORITY_LABELS[priorityOf(r.priority)])));
      bits.push(cell("Assignee", r.assigneeName ? esc(r.assigneeName) : "—"));
      bits.push(
        cell(
          "Deadline",
          `${esc(isoDate(r.deadline) || "—")}${sig === "overdue" ? ' <span class="late">Overdue</span>' : sig === "soon" ? ' <span class="soon">Due soon</span>' : ""}`
        )
      );
      bits.push(cell("Building · level", esc([r.buildingName ?? r.buildingId, r.storeyName].filter(Boolean).join(" · ") || "—")));
      if (cl.total > 0) bits.push(cell("Checklist", `${cl.done}/${cl.total}`));
      const photos = photoUrls
        .slice(0, REPORT_MAX_PHOTOS)
        .map((u) => `<img class="ph" src="${esc(u)}" alt="">`)
        .join("");
      const plan =
        locationThumbUrl && locationThumb2dUrl && isDualThumbLocation(r.location)
          ? `<img class="loc" src="${esc(locationThumb2dUrl)}" alt="plan snapshot">`
          : "";
      const thumb = locationThumbUrl ? `${plan}<img class="loc" src="${esc(locationThumbUrl)}" alt="location">` : "";
      return `<section class="task">
  <div class="head"><span class="num">${esc(formatTaskNum(r.num))}</span><h2>${esc(r.title)}</h2><span class="pill" style="background:${esc(accent.bg)};color:${esc(accent.ink)}">${esc(STATUS_LABELS[r.status] ?? String(r.status))}</span></div>
  ${r.description ? `<p class="desc">${esc(r.description).replace(/\n/g, "<br>")}</p>` : ""}
  <div class="body"><div class="grid">${bits.join("")}</div>${thumb}</div>
  ${photos ? `<div class="photos">${photos}</div>` : ""}
</section>`;
    })
    .join("\n");
  const truncated =
    meta.totalInView !== undefined && meta.totalInView > items.length
      ? `<p class="note">Showing the first ${items.length} of ${meta.totalInView} tasks in this view.</p>`
      : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Task report — ${esc(meta.projectName ?? "FreeField")}</title>
<style>
  @page { size: A4; margin: 14mm 12mm 20mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
  body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; margin: 0; }
  .brand { display:flex; justify-content:space-between; background:#0f172a; color:#fff; padding:10px 14px; border-radius:8px; }
  .brand b { letter-spacing:.16em; } .brand small { color:#cbd5e1; }
  h1 { font-size:18px; margin:14px 0 2px; } .sub { color:#6b7280; margin:0 0 12px; }
  .task { border:1px solid #e5e7eb; border-radius:8px; padding:10px 12px; margin-bottom:10px; break-inside:avoid; }
  .head { display:flex; align-items:center; gap:8px; }
  .num { font:700 12px ui-monospace, Menlo, monospace; background:#eef2ff; color:#3730a3; padding:4px 7px; border-radius:5px; }
  h2 { font-size:14px; margin:0; flex:1 1 auto; }
  .pill { padding:3px 10px; border-radius:999px; font-size:10.5px; font-weight:700; white-space:nowrap; }
  .desc { margin:6px 0 0; color:#374151; }
  .body { display:flex; gap:12px; margin-top:8px; align-items:flex-start; }
  .grid { flex:1 1 auto; display:grid; grid-template-columns:1fr 1fr 1fr; gap:6px 16px; }
  .k { font-size:9.5px; text-transform:uppercase; letter-spacing:.08em; color:#6b7280; font-weight:700; }
  .late { color:#dc2626; font-weight:700; } .soon { color:#b45309; font-weight:700; }
  img.loc { width:120px; height:80px; object-fit:cover; border-radius:6px; border:1px solid #e5e7eb; }
  .photos { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin-top:8px; }
  img.ph { width:100%; height:90px; object-fit:cover; border-radius:6px; border:1px solid #e5e7eb; }
  .note { color:#6b7280; font-style:italic; }
  footer { position:fixed; bottom:0; left:0; right:0; border-top:1px solid #e5e7eb; padding-top:4px; color:#6b7280; font-size:10px; background:#fff; display:flex; justify-content:space-between; }
</style></head><body>
<div class="brand"><b>FREE FIELD <small>Task report</small></b><small>${esc(printedAt)}${meta.printedBy ? ` · ${esc(meta.printedBy)}` : ""}</small></div>
<h1>${esc(meta.projectName ?? "Tasks")} — ${items.length} task${items.length === 1 ? "" : "s"}</h1>
<p class="sub">${esc(meta.filterNote ?? "Current view")}</p>
${truncated}
${cards || '<p class="note">No tasks in this view.</p>'}
<footer><span>FreeField task report · generated ${esc(printedAt)}</span><span>${items.length} tasks</span></footer>
</body></html>`;
}

/** Browser download of a binary blob (BCF). No-op without a DOM. */
export function downloadBlob(name: string, blob: Blob): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
