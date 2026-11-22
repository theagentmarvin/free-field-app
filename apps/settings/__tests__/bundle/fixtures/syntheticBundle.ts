// Synthetic FreeField bundle generator (tests + browser smoke script).
//
// One tiny IFC4 model (storey "Level 1", 3 walls at known coordinates),
// a plan sheet A101 whose PDF embeds `freefield-sheet.json` and whose
// viewport carries a (optionally rotated) pdfToModel, and a section sheet
// A201 the plan links to. No external PDF/zip tooling: the PDF is written
// by hand, the archive by jszip.

import JSZip from "jszip";

export const PAGE = { w: 1000, h: 800 };
const SCALE = 100;
/** metres per PDF point at 1:100 */
export const S = (SCALE * 0.0254) / 72;
const C = 5;
const F = 40;
const BUILDING_OFFSET: [number, number] = [10, 20];

export interface SyntheticOptions {
  /** Rotation of the plan in the model, radians (counter-clockwise). */
  rotationRad?: number;
  storeyName?: string;
  projectName?: string;
  /** Embed freefield-sheet.json in the plan PDF. */
  attach?: boolean;
  /** Manifest storey for the viewport (defaults to the IFC storey). */
  viewportStorey?: string;
}

interface Wall {
  name: string;
  gid: string;
  origin: [number, number];
  xdim: number;
  ydim: number;
  /** World bbox centre in the IFC (metres). */
  centre: [number, number];
}

/** Short walls keep perspective parallax small in top-down browser checks. */
export const WALL_HEIGHT = 1;

export const WALLS: Wall[] = [
  { name: "Wall A", gid: "3fixtureWallA00000000A", origin: [2, 3], xdim: 6, ydim: 0.2, centre: [15, 23.1] },
  { name: "Wall B", gid: "3fixtureWallB00000000B", origin: [8, 3], xdim: 0.2, ydim: 5, centre: [18.1, 25.5] },
  { name: "Wall C", gid: "3fixtureWallC00000000C", origin: [3, 7], xdim: 4, ydim: 0.2, centre: [15, 27.1] },
];

export function buildIfc(): string {
  const L: string[] = [];
  let id = 100;
  const add = (s: string): number => {
    L.push(`#${++id}=${s};`);
    return id;
  };
  const n = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));
  const prj = add(`IFCPROJECT('3fixtureProject0000000',$,'Fixture',$,$,$,$,(#20),#10)`);
  L.push(`#10=IFCUNITASSIGNMENT((#11));`);
  L.push(`#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`);
  L.push(`#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);`);
  L.push(`#21=IFCAXIS2PLACEMENT3D(#22,$,$);`);
  L.push(`#22=IFCCARTESIANPOINT((0.,0.,0.));`);
  L.push(`#23=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#20,$,.MODEL_VIEW.,$);`);
  L.push(`#24=IFCDIRECTION((0.,0.,1.));`);
  const sitePl = add(`IFCLOCALPLACEMENT($,#21)`);
  const site = add(`IFCSITE('3fixtureSite0000000000',$,'Site',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const bPt = add(`IFCCARTESIANPOINT((${n(BUILDING_OFFSET[0])},${n(BUILDING_OFFSET[1])},0.))`);
  const bAx = add(`IFCAXIS2PLACEMENT3D(#${bPt},$,$)`);
  const bPl = add(`IFCLOCALPLACEMENT(#${sitePl},#${bAx})`);
  const bld = add(`IFCBUILDING('3fixtureBuilding00000',$,'Building',$,$,#${bPl},$,$,.ELEMENT.,$,$,$)`);
  const stPl = add(`IFCLOCALPLACEMENT(#${bPl},#21)`);
  const storey = add(`IFCBUILDINGSTOREY('3fixtureStorey1000000',$,'Level 1',$,$,#${stPl},$,$,.ELEMENT.,0.)`);
  add(`IFCRELAGGREGATES('3fixtureRel1000000000',$,$,$,#${prj},(#${site}))`);
  add(`IFCRELAGGREGATES('3fixtureRel2000000000',$,$,$,#${site},(#${bld}))`);
  add(`IFCRELAGGREGATES('3fixtureRel3000000000',$,$,$,#${bld},(#${storey}))`);
  const products: number[] = [];
  for (const w of WALLS) {
    const pt = add(`IFCCARTESIANPOINT((${n(w.origin[0])},${n(w.origin[1])},0.))`);
    const ax = add(`IFCAXIS2PLACEMENT3D(#${pt},$,$)`);
    const pl = add(`IFCLOCALPLACEMENT(#${stPl},#${ax})`);
    const p2 = add(`IFCCARTESIANPOINT((${n(w.xdim / 2)},${n(w.ydim / 2)}))`);
    const a2 = add(`IFCAXIS2PLACEMENT2D(#${p2},$)`);
    const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${a2},${n(w.xdim)},${n(w.ydim)})`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#21,#24,${WALL_HEIGHT}.)`);
    const rep = add(`IFCSHAPEREPRESENTATION(#23,'Body','SweptSolid',(#${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    products.push(add(`IFCWALL('${w.gid}',$,'${w.name}',$,$,#${pl},#${shape},$,.STANDARD.)`));
  }
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('3fixtureRelC00000000',$,$,$,(${products.map((p) => "#" + p).join(",")}),#${storey})`);
  return [
    "ISO-10303-21;",
    "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('fixture.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    "ENDSEC;",
    "DATA;",
    ...L,
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
}

/** pdfToModel for a plan rotated by `theta` (CCW) about the model origin. */
export function planAffine(theta: number): [number, number, number, number, number, number] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c * S, s * S, C, s * S, -c * S, F];
}

export function applyAffine(
  m: readonly number[],
  px: number,
  py: number,
): { x: number; y: number } {
  return { x: m[0]! * px + m[1]! * py + m[2]!, y: m[3]! * px + m[4]! * py + m[5]! };
}

/** Minimal single-page PDF; optional embedded file `name`. */
export function buildPdf(opts: {
  width: number;
  height: number;
  rects?: Array<[number, number, number, number]>; // PDF-space top-left, y down
  /** Closed polygons in PDF space (top-left origin, y down). */
  polys?: Array<Array<[number, number]>>;
  attachment?: { name: string; json: string };
}): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (b: Uint8Array | string) => {
    const bytes = typeof b === "string" ? enc.encode(b) : b;
    parts.push(bytes);
    pos += bytes.length;
  };
  const obj = (num: number, body: string | Uint8Array) => {
    offsets[num] = pos;
    push(`${num} 0 obj\n`);
    push(body);
    push(`\nendobj\n`);
  };
  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");
  const att = opts.attachment;
  obj(
    1,
    `<< /Type /Catalog /Pages 2 0 R${
      att ? ` /Names << /EmbeddedFiles << /Names [(${att.name}) 6 0 R] >> >>` : ""
    } >>`,
  );
  obj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${opts.width} ${opts.height}] /Contents 4 0 R /Resources << >> >>`,
  );
  const content = [
    ...(opts.rects ?? []).map(([x0, y0, x1, y1]) => `${x0} ${opts.height - y1} ${x1 - x0} ${y1 - y0} re S`),
    ...(opts.polys ?? []).map(
      (p) => p.map(([x, y], k) => `${x} ${opts.height - y} ${k === 0 ? "m" : "l"}`).join(" ") + " h S",
    ),
  ].join(String.fromCharCode(10));
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  if (att) {
    const data = enc.encode(att.json);
    offsets[5] = pos;
    push(`5 0 obj\n<< /Type /EmbeddedFile /Subtype /application#2Fjson /Length ${data.length} >>\nstream\n`);
    push(data);
    push(`\nendstream\nendobj\n`);
    obj(6, `<< /Type /Filespec /F (${att.name}) /UF (${att.name}) /EF << /F 5 0 R >> >>`);
  }
  const count = att ? 7 : 5;
  const xrefAt = pos;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface SyntheticBundle {
  bytes: Uint8Array;
  manifest: Record<string, unknown>;
  affine: [number, number, number, number, number, number];
  /** Per wall: PDF bbox of the element on the plan sheet. */
  elementBoxes: Record<string, [number, number, number, number]>;
  /** Exact wall footprint in PDF space (pdfToModel^-1 of the IFC wall corners). */
  elementOutlines: Record<string, Array<[number, number]>>;
  /** The wall footprint corners in IFC world metres, as authored. */
  wallCorners: Record<string, Array<[number, number]>>;
}

export async function buildSyntheticBundle(
  opts: SyntheticOptions = {},
): Promise<SyntheticBundle> {
  const theta = opts.rotationRad ?? 0;
  const storeyName = opts.storeyName ?? "Level 1";
  const affine = planAffine(theta);
  // Wall centres (world IFC metres) -> PDF via the exact inverse.
  const det = affine[0] * affine[4] - affine[1] * affine[3];
  const toPdf = (mx: number, my: number) => {
    const dx = mx - affine[2];
    const dy = my - affine[5];
    return {
      x: (affine[4] * dx - affine[1] * dy) / det,
      y: (-affine[3] * dx + affine[0] * dy) / det,
    };
  };
  const elementBoxes: SyntheticBundle["elementBoxes"] = {};
  const elementOutlines: SyntheticBundle["elementOutlines"] = {};
  const wallCorners: SyntheticBundle["wallCorners"] = {};
  const elements = WALLS.map((w) => {
    const [cx, cy] = w.centre;
    const corners: Array<[number, number]> = [
      [cx - w.xdim / 2, cy - w.ydim / 2],
      [cx + w.xdim / 2, cy - w.ydim / 2],
      [cx + w.xdim / 2, cy + w.ydim / 2],
      [cx - w.xdim / 2, cy + w.ydim / 2],
    ];
    wallCorners[w.gid] = corners;
    const outline = corners.map(([mx, my]) => {
      const p = toPdf(mx, my);
      return [p.x, p.y] as [number, number];
    });
    elementOutlines[w.gid] = outline;
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    const bbox: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    elementBoxes[w.gid] = bbox;
    return { gid: w.gid, vp: "vp-1", bbox, outline };
  });
  const records: Record<string, unknown> = {};
  for (const w of WALLS) {
    records[w.gid] = {
      uid: `uid-${w.gid}`,
      eid: 1000 + WALLS.indexOf(w),
      gid: w.gid,
      category: "Walls",
      family: "Basic Wall",
      type: "Generic - 200mm",
      level: storeyName,
      modelId: "arch",
      params: {
        Mark: { v: w.name, d: w.name, t: false, k: "ALL_MODEL_MARK" },
        "Base Constraint": { v: storeyName, d: storeyName, t: false },
        Width: { v: 0.2, d: "200 mm", u: "mm", t: true },
      },
    };
  }
  const links = [
    {
      kind: "section",
      bbox: [20, 20, 60, 60] as [number, number, number, number],
      targetSheetId: "sheet-2",
      targetSheetNumber: "A201",
      targetViewId: "view-9",
    },
    { kind: "view", bbox: [80, 20, 120, 60] as [number, number, number, number], targetSheetId: null, targetSheetNumber: null },
  ];
  const region: [number, number, number, number] = [100, 100, 900, 700];
  const cp = (px: number, py: number) => {
    const m = applyAffine(affine, px, py);
    return { pdfX: px, pdfY: py, modelX: m.x, modelY: m.y };
  };
  const viewport = {
    id: "vp-1",
    viewId: "view-1",
    viewName: "Level 1",
    viewType: "FloorPlan",
    scale: SCALE,
    modelId: "arch",
    storeyName: opts.viewportStorey ?? storeyName,
    primary: true,
    pdfRegion: region,
    pdfToModel: affine,
    controlPoints: [cp(region[0], region[1]), cp(region[2], region[3])],
  };
  const payload = {
    schema: "freefield.sheet/1",
    sheetId: "sheet-1",
    sheetNumber: "A101",
    sheetName: "First Floor Plan",
    page: { widthPt: PAGE.w, heightPt: PAGE.h },
    viewports: [viewport],
    elements,
    elementRecords: records,
    links,
    schedules: [
      {
        name: "Wall Schedule",
        category: "Walls",
        columns: [
          { heading: "Mark", paramKey: "ALL_MODEL_MARK", fieldType: "instance" },
          { heading: "Width", paramKey: "Width", fieldType: "type" },
        ],
        rows: WALLS.map((w) => ({ gid: w.gid, uid: `uid-${w.gid}`, cells: [w.name, "0.2"] })),
      },
    ],
  };
  const plan = buildPdf({
    width: PAGE.w,
    height: PAGE.h,
    polys: elements.map((e) => e.outline),
    attachment:
      opts.attach === false ? undefined : { name: "freefield-sheet.json", json: JSON.stringify(payload) },
  });
  const sectionPayload = {
    schema: "freefield.sheet/1",
    sheetId: "sheet-2",
    sheetNumber: "A201",
    sheetName: "Sections",
    viewports: [],
    elements: [],
    elementRecords: {},
    links: [],
  };
  const section = buildPdf({
    width: 800,
    height: 600,
    attachment: { name: "freefield-sheet.json", json: JSON.stringify(sectionPayload) },
  });
  const manifest = {
    schema: "freefield.bundle/1",
    generator: { name: "FreeField Exporter", version: "0.1.0" },
    exportedAt: "2026-01-01T00:00:00.000Z",
    project: { name: opts.projectName ?? "Synthetic Project", number: "0" },
    units: { length: "m", pdf: "pt" },
    coordinates: { modelSpace: "ifc", ifcPlacement: "internal", trueNorthRad: 0 },
    models: [
      {
        id: "arch",
        file: "models/arch.ifc",
        name: "Arch",
        discipline: "architecture",
        storeys: [{ name: "Level 1", elevation: 0 }],
      },
    ],
    sheets: [
      {
        id: "sheet-1",
        number: "A101",
        name: "First Floor Plan",
        file: "sheets/A101.pdf",
        data: "data/sheets/A101.json",
        page: { widthPt: PAGE.w, heightPt: PAGE.h },
        viewports: [viewport],
      },
      {
        id: "sheet-2",
        number: "A201",
        name: "Sections",
        file: "sheets/A201.pdf",
        data: "data/sheets/A201.json",
        page: { widthPt: 800, heightPt: 600 },
        viewports: [
          {
            id: "vp-2",
            viewId: "view-9",
            viewName: "Section 1",
            viewType: "Section",
            scale: 50,
            modelId: "arch",
            storeyName: null,
            primary: false,
            pdfRegion: [0, 0, 800, 600],
            pdfToModel: null,
            controlPoints: null,
          },
        ],
      },
    ],
    schedules: [],
    elementsFile: "data/elements.json",
    stats: { elements: WALLS.length, sheets: 2, viewports: 2, links: 1 },
  };
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("models/arch.ifc", buildIfc());
  zip.file("sheets/A101.pdf", plan);
  zip.file("sheets/A201.pdf", section);
  zip.file("data/elements.json", JSON.stringify(records));
  zip.file("data/sheets/A101.json", JSON.stringify({ sheetId: "sheet-1", elements, links }));
  zip.file("data/sheets/A201.json", JSON.stringify({ sheetId: "sheet-2", elements: [], links: [] }));
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, manifest, affine, elementBoxes, elementOutlines, wallCorners };
}
