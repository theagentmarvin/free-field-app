import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildBcfFiles, cameraToBcf, exportBcf, guidFor, toBcfDate } from '../../src/bcf';
import type { BcfTaskBundle, BcfVersion } from '../../src/bcf';
import { allBundles, fullBundle, minimalBundle, options } from './fixtures';

const FIXTURES = [...allBundles];

describe.each(['2.1', '3.0'] as const)('GUID uniqueness %s', (version: BcfVersion) => {
  it('every GUID in an export is unique', async () => {
    const { files } = await buildBcfFiles(FIXTURES, options(version));
    const guids: string[] = [];
    for (const [p, c] of files) {
      if (typeof c !== 'string' || !/\.(bcf|bcfv)$/.test(p)) continue;
      for (const m of c.matchAll(/ Guid="([^"]+)"/g)) guids.push(m[1]!);
      for (const m of c.matchAll(/<DocumentGuid>([^<]+)</g)) void m; // references, not definitions
    }
    // viewpoint GUID is defined in markup (ViewPoint) and repeated in the .bcfv root: count once
    const defs = new Map<string, number>();
    for (const [p, c] of files) {
      if (typeof c !== 'string' || !p.endsWith('markup.bcf')) continue;
      for (const m of c.matchAll(/ Guid="([^"]+)"/g)) defs.set(m[1]!, (defs.get(m[1]!) ?? 0) + 1);
    }
    expect(guids.length).toBeGreaterThan(20);
    for (const [g, n] of defs) expect(n, g).toBe(1);
  });
  it('viewpoint guid differs from the topic guid for a UUID task id', async () => {
    const { files } = await buildBcfFiles([fullBundle], options(version));
    const bcfv = files.get(`${fullBundle.task.id}/viewpoint.bcfv`) as string;
    expect(bcfv).not.toContain(`Guid="${fullBundle.task.id}"`);
  });
});

describe('guidFor kinds', () => {
  it('only task and entry keep UUID ids', () => {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(guidFor('task', id)).toBe(id);
    expect(guidFor('entry', id)).toBe(id);
    expect(guidFor('viewpoint', id)).not.toBe(id);
    expect(guidFor('doc', id)).not.toBe(guidFor('docref', id));
  });
});

describe('camera round trip (independent forward formula)', () => {
  const forward = (ifc: [number, number, number], s: [number, number, number]): [number, number, number] => [ifc[0] + s[0], ifc[2] + s[1], -ifc[1] + s[2]];
  const cases: { pos: [number, number, number]; tgt: [number, number, number]; shift: [number, number, number] }[] = [
    { pos: [10, 20, 3], tgt: [12, 25, 3], shift: [100, 5, -200] },
    { pos: [-5.5, 7.25, 12], tgt: [0, 0, 0], shift: [0, 0, 0] },
    { pos: [1000, -2000, 30], tgt: [990, -1990, 25], shift: [-34.5, 12.75, 88] },
    { pos: [0, 0, 50], tgt: [3, 4, 0], shift: [1e5, 20, -1e5] },
  ];
  it.each(cases)('recovers IFC values %#', ({ pos, tgt, shift }) => {
    const wp = forward(pos, shift);
    const wt = forward(tgt, shift);
    const cam = cameraToBcf({ pos: wp, target: wt, fov: 50, isOrtho: false }, shift, '3.0');
    pos.forEach((v, i) => expect(cam.viewPoint[i]).toBeCloseTo(v, 5));
    const d = [tgt[0] - pos[0], tgt[1] - pos[1], tgt[2] - pos[2]];
    const l = Math.hypot(...d);
    d.forEach((v, i) => expect(cam.direction[i]).toBeCloseTo(v / l, 5));
    // up is perpendicular to the direction and has a positive IFC-Z component unless looking vertically
    const dot = cam.direction[0] * cam.up[0] + cam.direction[1] * cam.up[1] + cam.direction[2] * cam.up[2];
    expect(Math.abs(dot)).toBeLessThan(1e-5);
  });
  it('hand check: IFC (10,20,3) with shift (100,5,-200) is world (110,8,-220)', () => {
    expect(forward([10, 20, 3], [100, 5, -200])).toEqual([110, 8, -220]);
    const cam = cameraToBcf({ pos: [110, 8, -220], target: [110, 8, -221], fov: 50, isOrtho: false }, [100, 5, -200], '2.1');
    expect(cam.viewPoint).toEqual([10, 20, 3]);
    expect(cam.direction).toEqual([0, 1, 0]);
  });
});

describe('dates', () => {
  it('toBcfDate never throws', () => {
    for (const v of [NaN, Infinity, -Infinity, 1e20, -1e20, 0]) expect(() => toBcfDate(v)).not.toThrow();
    expect(toBcfDate(253402300799000)).toBe('9999-12-31T23:59:59Z');
  });
  it('omits optional dates out of range and falls back for required ones', async () => {
    const b: BcfTaskBundle = {
      task: { ...minimalBundle.task, createdAt: NaN, updatedAt: 1e20, deadline: 0 },
      entries: [{ id: 'e1', action: 'comment', text: 'x', by: 'a', byUid: 'a', at: Infinity, statusFrom: null, statusTo: null }],
    };
    for (const v of ['2.1', '3.0'] as const) {
      const { files } = await buildBcfFiles([b], options(v));
      const m = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
      expect(m).not.toContain('<DueDate>');
      expect(m).not.toContain('<ModifiedDate>');
      expect(m).toContain('<CreationDate>2026-11-22T12:00:00Z</CreationDate>');
      expect(m).toContain('<Date>2026-11-22T12:00:00Z</Date>');
    }
  });
});

describe('camera edge cases and warnings', () => {
  const mk = (pose: BcfTaskBundle['task']['cameraPose']): BcfTaskBundle => ({ task: { ...minimalBundle.task, id: 'edge', cameraPose: pose }, entries: [] });
  it.each([
    ['NaN pos', { pos: [NaN, 0, 0], target: [0, 0, 0], fov: 50, isOrtho: false }],
    ['Infinity target', { pos: [0, 0, 0], target: [0, Infinity, 0], fov: 50, isOrtho: false }],
    ['NaN fov', { pos: [0, 1, 0], target: [0, 0, 0], fov: NaN, isOrtho: false }],
    ['pos == target', { pos: [1, 2, 3], target: [1, 2, 3], fov: 50, isOrtho: false }],
  ] as const)('skips the 3D view for %s', async (_n, pose) => {
    const { files, warnings } = await buildBcfFiles([mk({ ...pose, pos: [...pose.pos], target: [...pose.target] } as never)], options('3.0'));
    expect([...files.keys()].some((k) => k.endsWith('.bcfv'))).toBe(false);
    expect(warnings.map((w) => w.kind)).toContain('no-3d-view');
  });
  it('warns when the ortho scale is estimated', async () => {
    const { warnings } = await buildBcfFiles([mk({ pos: [0, 5, 0], target: [0, 0, 0], fov: 45, isOrtho: true })], options('3.0'));
    expect(warnings.map((w) => w.kind)).toContain('ortho-scale-estimated');
  });
});

describe('zip', () => {
  it.each(['2.1', '3.0'] as const)('is byte-identical across runs and compresses per type (%s)', async (v) => {
    const a = new Uint8Array(await (await exportBcf(FIXTURES, options(v))).blob.arrayBuffer());
    const res = await exportBcf(FIXTURES, options(v));
    const b = new Uint8Array(await res.blob.arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(res.filename.endsWith(v === '2.1' ? '-bcf21.bcfzip' : '-bcf30.bcf')).toBe(true);
    const zip = await JSZip.loadAsync(b);
    const method = (p: string) => (zip.file(p) as unknown as { _data: { compression: { magic: string } } })._data.compression.magic;
    expect(method('bcf.version')).toBe('\x08\x00'); // DEFLATE
    expect(method(`${fullBundle.task.id}/markup.bcf`)).toBe('\x08\x00');
    expect(method(`${fullBundle.task.id}/snapshot.jpg`.replace('.jpg', v === '2.1' ? '.jpg' : '.jpg'))).toBe('\x00\x00'); // STORE
  });
});
