// apps/documents/src/sheetData/xlsx.ts
//
// Minimal SpreadsheetML (.xlsx) writer: one worksheet, a bold frozen header
// row, shared strings for text and real numeric cells for numbers.

import { zipStore } from "./zipStore";

export type Cell = string | number | null | undefined;

export interface XlsxTable {
  /** Worksheet name (sanitised to Excel's rules). */
  sheetName: string;
  headers: readonly string[];
  rows: readonly (readonly Cell[])[];
}

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Control characters (except tab, LF, CR) are illegal in XML 1.0.
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function xmlEscape(s: string): string {
  return s
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "");
  return (cleaned || "Sheet1").slice(0, 31);
}

export function buildXlsx(table: XlsxTable): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sst = (s: string): number => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };

  const width = Math.max(table.headers.length, ...table.rows.map((r) => r.length), 1);
  const rowXml: string[] = [];
  const headerCells = table.headers
    .map((h, c) => `<c r="${columnName(c)}1" s="1" t="s"><v>${sst(h)}</v></c>`)
    .join("");
  rowXml.push(`<row r="1">${headerCells}</row>`);
  table.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((v, c) => {
      if (v === null || v === undefined || v === "") return;
      const ref = `${columnName(c)}${r + 2}`;
      if (typeof v === "number" && Number.isFinite(v)) cells.push(`<c r="${ref}"><v>${v}</v></c>`);
      else cells.push(`<c r="${ref}" t="s"><v>${sst(String(v))}</v></c>`);
    });
    rowXml.push(`<row r="${r + 2}">${cells.join("")}</row>`);
  });

  const lastRef = `${columnName(width - 1)}${table.rows.length + 1}`;
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<sheetData>${rowXml.join("")}</sheetData></worksheet>`;

  const sharedStrings =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">` +
    strings.map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`).join("") +
    `</sst>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEscape(sanitizeSheetName(table.sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const enc = new TextEncoder();
  const part = (name: string, xml: string) => ({ name, data: enc.encode(xml) });
  return zipStore([
    part("[Content_Types].xml", contentTypes),
    part("_rels/.rels", rootRels),
    part("xl/workbook.xml", workbook),
    part("xl/_rels/workbook.xml.rels", workbookRels),
    part("xl/styles.xml", styles),
    part("xl/sharedStrings.xml", sharedStrings),
    part("xl/worksheets/sheet1.xml", sheet),
  ]);
}
