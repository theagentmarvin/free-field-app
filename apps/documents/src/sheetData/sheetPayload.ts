// apps/documents/src/sheetData/sheetPayload.ts
//
// The per-sheet data a FreeField bundle embeds in every sheet PDF as the
// attached file `freefield-sheet.json` (schema "freefield.sheet/1"):
// which elements are drawn where on the page, their parameters, and the
// links to other sheets. Read through pdf.js `getAttachments()`; plain
// PDFs simply have no attachment and everything stays as it was.
//
// Coordinates are PDF points, origin top-left, y down (the same space
// PdfOverlay's `onTap` reports).

export const SHEET_ATTACHMENT_NAME = "freefield-sheet.json";
export const SHEET_PAYLOAD_SCHEMA = "freefield.sheet/1";

export type Bbox = [number, number, number, number];

export interface SheetParam {
  v?: string | number | boolean | null;
  d?: string | null;
  u?: string | null;
  /** True when the parameter belongs to the element type. */
  t?: boolean;
  k?: string | null;
}

export interface SheetElementRecord {
  uid?: string;
  eid?: number;
  gid: string;
  category?: string;
  bic?: string;
  family?: string;
  type?: string;
  level?: string;
  modelId?: string;
  params: Record<string, SheetParam>;
}

export interface SheetElement {
  gid: string;
  vp?: string;
  bbox: Bbox;
  outline?: Array<[number, number]>;
}

export interface SheetLink {
  kind: string;
  bbox: Bbox;
  targetSheetId?: string | null;
  targetSheetNumber?: string | null;
  targetViewId?: string | null;
  /** False when the target sheet was not exported in the bundle (absent = unknown/true). */
  targetIncluded?: boolean;
}

/** A schedule placed on the sheet: columns, and rows bound to elements by GlobalId. */
export interface SheetSchedule {
  name: string;
  category?: string;
  columns: Array<{ heading: string; paramKey?: string; fieldType?: string }>;
  rows: Array<{ gid?: string; uid?: string; cells: Array<string | number> }>;
}

export interface SheetPayload {
  schema: typeof SHEET_PAYLOAD_SCHEMA;
  sheetId: string;
  sheetNumber: string;
  sheetName: string;
  page?: { widthPt: number; heightPt: number };
  elements: SheetElement[];
  elementRecords: Record<string, SheetElementRecord>;
  links: SheetLink[];
  /** Optional: schedules placed on this sheet (absent in older bundles). */
  schedules: SheetSchedule[];
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function asBbox(v: unknown): Bbox | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(isNum)) return null;
  const [x0, y0, x1, y1] = v as number[];
  return [Math.min(x0!, x1!), Math.min(y0!, y1!), Math.max(x0!, x1!), Math.max(y0!, y1!)];
}

function asOutline(v: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(v) || v.length < 3) return undefined;
  const pts: Array<[number, number]> = [];
  for (const p of v) {
    if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return undefined;
    pts.push([p[0], p[1]]);
  }
  return pts;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Parse + validate an embedded payload. Returns null for anything that is
 * not a `freefield.sheet/1` document; malformed entries are dropped, not
 * fatal.
 */
export function parseSheetPayload(raw: string | Uint8Array): SheetPayload | null {
  let data: unknown;
  try {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (o.schema !== SHEET_PAYLOAD_SCHEMA) return null;

  const elements: SheetElement[] = [];
  if (Array.isArray(o.elements)) {
    for (const e of o.elements) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      const bbox = asBbox(r.bbox);
      if (typeof r.gid !== "string" || !bbox) continue;
      elements.push({ gid: r.gid, vp: str(r.vp), bbox, outline: asOutline(r.outline) });
    }
  }

  const links: SheetLink[] = [];
  if (Array.isArray(o.links)) {
    for (const l of o.links) {
      if (!l || typeof l !== "object") continue;
      const r = l as Record<string, unknown>;
      const bbox = asBbox(r.bbox);
      if (!bbox) continue;
      links.push({
        kind: str(r.kind) ?? "view",
        bbox,
        targetSheetId: str(r.targetSheetId) ?? null,
        targetSheetNumber: str(r.targetSheetNumber) ?? null,
        targetViewId: str(r.targetViewId) ?? null,
        targetIncluded: typeof r.targetIncluded === "boolean" ? r.targetIncluded : undefined,
      });
    }
  }

  const elementRecords: Record<string, SheetElementRecord> = {};
  if (o.elementRecords && typeof o.elementRecords === "object") {
    for (const [gid, rec] of Object.entries(o.elementRecords as Record<string, unknown>)) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      const params: Record<string, SheetParam> = {};
      if (r.params && typeof r.params === "object") {
        for (const [k, p] of Object.entries(r.params as Record<string, unknown>)) {
          if (p && typeof p === "object") params[k] = p as SheetParam;
        }
      }
      elementRecords[gid] = {
        gid,
        uid: str(r.uid),
        eid: isNum(r.eid) ? r.eid : undefined,
        category: str(r.category),
        bic: str(r.bic),
        family: str(r.family),
        type: str(r.type),
        level: str(r.level),
        modelId: str(r.modelId),
        params,
      };
    }
  }

  const schedules: SheetSchedule[] = [];
  if (Array.isArray(o.schedules)) {
    for (const s of o.schedules) {
      if (!s || typeof s !== "object") continue;
      const r = s as Record<string, unknown>;
      if (!Array.isArray(r.columns) || !Array.isArray(r.rows)) continue;
      const columns = r.columns.map((c, i) => {
        if (typeof c === "string") return { heading: c };
        const cc = (c ?? {}) as Record<string, unknown>;
        return { heading: str(cc.heading) ?? `Column ${i + 1}`, paramKey: str(cc.paramKey), fieldType: str(cc.fieldType) };
      });
      const rows: SheetSchedule["rows"] = [];
      for (const row of r.rows) {
        if (!row || typeof row !== "object" || !Array.isArray((row as { cells?: unknown }).cells)) continue;
        const rr = row as { gid?: unknown; uid?: unknown; cells: unknown[] };
        rows.push({
          gid: str(rr.gid),
          uid: str(rr.uid),
          cells: rr.cells.map((c) => (typeof c === "number" || typeof c === "string" ? c : c == null ? "" : String(c))),
        });
      }
      schedules.push({ name: str(r.name) ?? `Schedule ${schedules.length + 1}`, category: str(r.category), columns, rows });
    }
  }

  const page =
    o.page && typeof o.page === "object" && isNum((o.page as { widthPt?: unknown }).widthPt)
      ? (o.page as { widthPt: number; heightPt: number })
      : undefined;
  return {
    schema: SHEET_PAYLOAD_SCHEMA,
    sheetId: str(o.sheetId) ?? "",
    sheetNumber: str(o.sheetNumber) ?? "",
    sheetName: str(o.sheetName) ?? "",
    page,
    elements,
    elementRecords,
    links,
    schedules,
  };
}

/** The slice of a pdf.js document the attachment reader needs. */
export interface AttachmentSource {
  /**
   * pdf.js 5: `Record<name, { filename, content }>`. pdf.js 6: a `Map<id, { filename }>`
   * of metadata only, with the bytes read through `getAttachmentContent(id)`.
   * Both shapes are accepted.
   */
  getAttachments(): Promise<
    | Record<string, { filename?: string; content: Uint8Array }>
    | Map<string, { filename?: string }>
    | null
  >;
  getAttachmentContent?(id: string): Promise<Uint8Array | null | undefined>;
}

/**
 * Read `freefield-sheet.json` from a PDF document: the payload, `null` when the
 * PDF definitively has none (absent / invalid), `undefined` when reading failed
 * (transient; callers must not cache that).
 */
export async function readSheetPayload(doc: AttachmentSource): Promise<SheetPayload | null | undefined> {
  let attachments: Awaited<ReturnType<AttachmentSource["getAttachments"]>>;
  try {
    attachments = await doc.getAttachments();
  } catch {
    return undefined;
  }
  if (!attachments) return null;
  if (attachments instanceof Map) {
    let id: string | undefined;
    for (const [key, meta] of attachments) {
      if (key === SHEET_ATTACHMENT_NAME || meta?.filename === SHEET_ATTACHMENT_NAME) {
        id = key;
        break;
      }
    }
    if (id === undefined || typeof doc.getAttachmentContent !== "function") return null;
    try {
      const content = await doc.getAttachmentContent(id);
      return content ? parseSheetPayload(content) : null;
    } catch {
      return undefined;
    }
  }
  const hit =
    attachments[SHEET_ATTACHMENT_NAME] ??
    Object.values(attachments).find((a) => a.filename === SHEET_ATTACHMENT_NAME);
  return hit ? parseSheetPayload(hit.content) : null;
}

// ── Cache: one parse per PDF version (blobs are immutable per version) ──
const CACHE_LIMIT = 24;
const cache = new Map<string, SheetPayload | null>();

export function getCachedPayload(versionId: string): SheetPayload | null | undefined {
  return cache.get(versionId);
}

export function setCachedPayload(versionId: string, payload: SheetPayload | null): void {
  cache.delete(versionId);
  cache.set(versionId, payload);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearPayloadCache(): void {
  cache.clear();
}
