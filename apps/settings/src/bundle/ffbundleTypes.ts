// src/bundle/ffbundleTypes.ts
//
// Types for the FreeField bundle format `freefield.bundle/1` (a zip with a
// manifest, IFC models, one single-page PDF per sheet and sidecar data).
// Coordinate contract:
//   PDF space  : points, origin top-left of the page, y down.
//   Model space: IFC world coordinates in metres, exactly as authored in the IFC.
//   pdfToModel : [a,b,c,d,e,f]  modelX = a*px + b*py + c ; modelY = d*px + e*py + f

export type Bbox4 = [number, number, number, number]; // [x0, y0, x1, y1]
export type Affine6 = [number, number, number, number, number, number];

export interface BundleManifest {
  schema: 'freefield.bundle/1';
  generator: { name: string; version: string; host?: string; hostVersion?: string };
  exportedAt: string; // ISO-8601
  project: { name: string; number?: string; sourceFile?: string };
  units: { length: 'm'; pdf: 'pt' };
  coordinates: {
    modelSpace: 'ifc';
    ifcPlacement: 'internal' | 'projectBasePoint' | 'surveyPoint' | 'shared';
    trueNorthRad?: number;
  };
  models: ModelEntry[];
  sheets: SheetEntry[];
  schedules: ScheduleEntry[];
  elementsFile: string; // "data/elements.json"
  stats: { elements: number; sheets: number; viewports: number; links: number };
}

export interface ModelEntry {
  id: string;
  file: string; // models/<id>.ifc
  name?: string;
  discipline?: string;
  storeys: StoreyEntry[];
}

export interface StoreyEntry {
  name: string; // equals IfcBuildingStorey.Name
  elevation: number; // metres
  levelUniqueId?: string;
  ifcGlobalId?: string;
}

export interface SheetEntry {
  id: string;
  number: string;
  name: string;
  file: string; // sheets/<stem>.pdf (single page)
  data: string; // data/sheets/<stem>.json
  page: { widthPt: number; heightPt: number };
  viewports: ViewportEntry[];
}

export interface ViewportEntry {
  id: string;
  viewId: string;
  viewName: string;
  viewType: string;
  scale: number; // denominator, 96 => 1:96
  modelId?: string | null;
  storeyName?: string | null;
  primary: boolean; // one primary viewport per (sheet, storey)
  pdfRegion: Bbox4; // points, top-left origin, y down
  pdfToModel: Affine6 | null; // null for non-plan viewports
  controlPoints?: ControlPoint[] | null; // 2 far-apart points, exact under pdfToModel
}

export interface ControlPoint {
  pdfX: number;
  pdfY: number;
  modelX: number;
  modelY: number;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  category?: string;
  file: string; // data/schedules/<slug>.json
}

// data/elements.json : keyed by IFC GlobalId
export type ElementsFile = Record<string, ElementRecord>;

export interface ElementRecord {
  uid: string; // source element unique id
  eid?: number; // source element numeric id
  gid: string; // IFC GlobalId
  category?: string;
  bic?: string; // built-in category name
  family?: string;
  type?: string;
  level?: string;
  modelId?: string;
  params: Record<string, ParamValue>;
}

export interface ParamValue {
  v?: string | number | boolean | null; // raw value
  d?: string | null; // display string
  u?: string | null; // unit
  t?: boolean; // true when the parameter belongs to the element type
  k?: string | null; // stable key (built-in parameter name | shared GUID | name)
}

// data/sheets/<stem>.json
export interface SheetElementIndex {
  sheetId: string;
  elements: SheetElement[];
  links: SheetLink[];
}

export interface SheetElement {
  gid: string;
  vp: string; // viewport id
  bbox: Bbox4; // PDF points, top-left origin
  outline?: Array<[number, number]>;
}

export interface SheetLink {
  kind: 'section' | 'elevation' | 'callout' | 'detail' | 'view';
  bbox: Bbox4;
  targetSheetId?: string | null;
  targetSheetNumber?: string | null;
  targetViewId?: string | null;
}

// data/schedules/<slug>.json
export interface DataTable {
  name: string;
  category?: string;
  columns: DataColumn[];
  rows: DataRow[];
}

export interface DataColumn {
  heading: string;
  paramKey: string;
  fieldType: 'instance' | 'type';
}

export interface DataRow {
  gid: string;
  uid: string;
  cells: string[];
}

// Attached to each sheet PDF as the embedded file `freefield-sheet.json` (self-sufficient)
export interface EmbeddedSheetPayload {
  schema: 'freefield.sheet/1';
  sheetId: string;
  sheetNumber: string;
  sheetName: string;
  page?: { widthPt: number; heightPt: number };
  viewports: ViewportEntry[]; // id, storeyName, pdfRegion, pdfToModel, ...
  elements: SheetElement[]; // the SheetElementIndex entries
  elementRecords: ElementsFile; // records referenced by `elements`, keyed by gid
  links: SheetLink[]; // with targetSheetId and targetSheetNumber
}
