import type { BcfBinary, BcfTaskBundle, BcfUserDirectory, BcfExportOptions, BcfVersion } from '../../src/bcf';

/** Minimal valid 1x1 PNG. */
export const PNG_1x1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
);

/** Synthetic JPEG header (SOI, APP0, SOF0, EOI): enough for the dimension parser. */
export function fakeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

export const jpegSnapshot = (w = 400, h = 300): BcfBinary => ({ bytes: fakeJpeg(w, h), mime: 'image/jpeg' });
export const pngSnapshot = (): BcfBinary => ({ bytes: PNG_1x1, mime: 'image/png' });

export const users: BcfUserDirectory = {
  author: (uid, fallback) => (uid === 'u1' ? 'ana@example.com' : uid === 'u2' ? 'bo@example.com' : (fallback ?? uid ?? null)),
  authorByName: (n) => (n === 'Ana Silva' ? 'ana@example.com' : (n ?? null)),
};

export const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
export const SHIFT: [number, number, number] = [100, 20, -50];

export function options(version: BcfVersion, extra: Partial<BcfExportOptions> = {}): BcfExportOptions {
  return {
    version,
    project: { id: 'proj-1', name: 'Tower A' },
    users,
    baseShift: SHIFT,
    taskUrl: (id) => `https://app.example.com/tasks/${id}`,
    now: () => NOW,
    ...extra,
  };
}

const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const IFC = (s: string) => s.padEnd(22, 'x').slice(0, 22);

function base(id: string, num: number, over: Partial<BcfTaskBundle['task']> = {}): BcfTaskBundle['task'] {
  return {
    id,
    num,
    title: `Task ${num}`,
    description: '',
    type: 'task',
    status: 20,
    priority: null,
    createdAt: Date.UTC(2026, 4, 2, 9, 15, 0),
    createdByUid: 'u1',
    createdBy: 'Ana Silva',
    updatedAt: Date.UTC(2026, 4, 3, 10, 0, 0),
    updatedBy: 'Ana Silva',
    assigneeUid: null,
    assigneeName: null,
    deadline: null,
    ...over,
  };
}

const entry = (id: string, action: string, text: string, over = {}) => ({
  id, action, text, by: 'Ana Silva', byUid: 'u1', at: Date.UTC(2026, 4, 2, 9, 30, 0), statusFrom: null, statusTo: null, ...over,
});

export const fullBundle: BcfTaskBundle = {
  task: base(UUID_A, 1, {
    title: 'Crack in beam',
    description: 'Cracks near the support.',
    status: 40,
    priority: 'high',
    checklist: [{ text: 'Photograph', done: true }, { text: 'Notify engineer', done: false }],
    assigneeUid: 'u2',
    assigneeName: 'Bo',
    deadline: Date.UTC(2026, 5, 1, 0, 0, 0),
    buildingName: 'Tower A',
    storeyName: 'Level 3',
    locationText: 'Grid C/4',
    sheetPinNote: 'Sheet A101 · page 1 · at 42 %, 61 %',
    sheetRefs: [{ name: 'A101', page: 1, versionNumber: 3 }, { name: 'S200' }],
    cameraPose: { pos: [110, 25, -60], target: [100, 21, -50], fov: 50, isOrtho: false },
  }),
  entries: [
    entry('e-0001', 'create', ''),
    entry('e-0002', 'comment', 'Please check.'),
    entry('e-0003', 'complete', 'Done', { statusFrom: 20, statusTo: 40, byUid: 'u2', by: 'Bo' }),
  ],
  snapshot: jpegSnapshot(),
  photos: [
    { binary: { bytes: fakeJpeg(10, 10), mime: 'image/jpeg' }, caption: 'Front' },
    { binary: { bytes: PNG_1x1, mime: 'image/png' }, entryId: 'e-0002' },
  ],
  components: [
    { ifcGuid: IFC('0abcDEFghi_$12'), originatingSystem: 'model.ifc', authoringToolId: 'm1:100' },
    { ifcGuid: IFC('1abcDEFghi_$12') },
    { ifcGuid: IFC('2abcDEFghi_$12') },
  ],
  unresolvedComponents: 1,
};

export const minimalBundle: BcfTaskBundle = { task: base('t-min', 2, { title: 'Minimal' }), entries: [] };

export const twoDOnlyBundle: BcfTaskBundle = {
  task: base('t-2d', 3, { title: 'Pin on sheet', sheetPinNote: 'Sheet A101 · page 2 · at 10 %, 20 %', sheetRefs: [{ name: 'A101', page: 2 }] }),
  entries: [entry('e-2d-1', 'create', '')],
  snapshot: pngSnapshot(),
};

export const orthoBundle: BcfTaskBundle = {
  task: base('t-ortho', 4, { title: 'Ortho', cameraPose: { pos: [100, 60, -50], target: [100, 20, -50], fov: 45, isOrtho: true } }),
  entries: [],
  components: [{ ifcGuid: IFC('3abcDEFghi_$12') }],
};

export const straightDownBundle: BcfTaskBundle = {
  task: base('t-down', 5, { title: 'Down', priority: 'critical', cameraPose: { pos: [100, 50, -50], target: [100, 0, -50], fov: 70, isOrtho: false } }),
  entries: [],
  snapshot: jpegSnapshot(1600, 900),
};

export const nonUuidBundle: BcfTaskBundle = {
  task: base('abc123XYZ', 6, { title: 'Non UUID id', priority: 'low' }),
  entries: [entry('weird entry id', 'edit', 'Changed title')],
};

export const unicodeBundle: BcfTaskBundle = {
  task: base('t-uni', 7, {
    title: `Café – 中文 & <b> "q" 'a' \u{1F600}`,
    description: `Line 1 & <tag> "x" 'y'\nSecond üñí \u0001 ctrl`,
  }),
  entries: [entry('e-uni', 'comment', `5 < 6 & 7 > 3 "ok" 'fine' é`)],
};

export const noShiftBundle: BcfTaskBundle = {
  task: base('t-noshift', 8, { title: 'Camera but no shift', cameraPose: { pos: [1, 2, 3], target: [0, 0, 0], fov: 50, isOrtho: false } }),
  entries: [],
  snapshot: jpegSnapshot(),
};

export const allBundles: BcfTaskBundle[] = [
  fullBundle, minimalBundle, twoDOnlyBundle, orthoBundle, straightDownBundle, nonUuidBundle, unicodeBundle,
];
