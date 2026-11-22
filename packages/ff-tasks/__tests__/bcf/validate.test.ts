import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { validateXML } from 'xmllint-wasm';
import { describe, expect, it } from 'vitest';
import { buildBcfFiles, exportBcf } from '../../src/bcf';
import type { BcfTaskBundle, BcfVersion } from '../../src/bcf';
import {
  allBundles, fullBundle, minimalBundle, noShiftBundle, nonUuidBundle, options, pngSnapshot, straightDownBundle, twoDOnlyBundle,
} from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const xsd = (v: BcfVersion, name: string) => ({
  fileName: name,
  contents: readFileSync(join(here, 'xsd', v, name), 'utf8'),
});

function schemaFor(path: string): string | null {
  const base = path.split('/').pop()!;
  if (base === 'bcf.version') return 'version.xsd';
  if (base === 'project.bcfp') return 'project.xsd';
  if (base === 'markup.bcf') return 'markup.xsd';
  if (base.endsWith('.bcfv')) return 'visinfo.xsd';
  if (base === 'extensions.xml') return 'extensions.xsd';
  if (base === 'documents.xml') return 'documents.xsd';
  return null;
}

/** Validates every XML file (one xmllint batch per schema); on failure re-runs per file for attribution. */
async function validateFiles(v: BcfVersion, files: Map<string, string | Uint8Array>) {
  const results: { path: string; valid: boolean; errors: string }[] = [];
  const bySchema = new Map<string, { fileName: string; contents: string }[]>();
  for (const [path, content] of files) {
    const s = schemaFor(path);
    if (!s || typeof content !== 'string') continue;
    if (!bySchema.has(s)) bySchema.set(s, []);
    bySchema.get(s)!.push({ fileName: path, contents: content });
  }
  const preload = v === '3.0' ? [xsd(v, 'shared-types.xsd')] : [];
  for (const [s, xmls] of bySchema) {
    const r = await validateXML({ xml: xmls, schema: [xsd(v, s)], preload });
    if (r.valid) {
      xmls.forEach((x) => results.push({ path: x.fileName, valid: true, errors: '' }));
      continue;
    }
    for (const x of xmls) {
      const one = await validateXML({ xml: [x], schema: [xsd(v, s)], preload });
      results.push({ path: x.fileName, valid: one.valid, errors: one.errors.map((e) => e.message).join('\n') });
    }
  }
  return results;
}

const scenarios: [string, BcfTaskBundle[]][] = [
  ['all fixtures together', allBundles],
  ['full', [fullBundle]],
  ['minimal', [minimalBundle]],
  ['2D only', [twoDOnlyBundle]],
  ['straight down', [straightDownBundle]],
  ['non-UUID id', [nonUuidBundle]],
  ['camera with null shift', [noShiftBundle]],
  ['no bundles', []],
  ['priority unset', [{ ...minimalBundle, task: { ...minimalBundle.task, priority: undefined } }]],
];

describe.each(['2.1', '3.0'] as const)('XSD validation BCF %s', (version) => {
  it.each(scenarios)('%s validates', async (name, bundles) => {
    const opts = options(version, name.includes('null shift') ? { baseShift: null } : {});
    const { files } = await buildBcfFiles(bundles, opts);
    const results = await validateFiles(version, files);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      if (!r.valid) console.error(`${r.path}\n${r.errors}`);
      expect(r.valid, r.path).toBe(true);
    }
  });

  it('writes every kind of XML file the schemas cover', async () => {
    const { files } = await buildBcfFiles(allBundles, options(version));
    const kinds = new Set([...files.keys()].map((p) => schemaFor(p)).filter(Boolean));
    const expected = version === '3.0'
      ? ['version.xsd', 'project.xsd', 'markup.xsd', 'visinfo.xsd', 'extensions.xsd', 'documents.xsd']
      : ['version.xsd', 'project.xsd', 'markup.xsd', 'visinfo.xsd'];
    expect([...kinds].sort()).toEqual(expected.sort());
  });
});

describe('validator negative checks', () => {
  it('rejects an uppercase GUID in 3.0 markup', async () => {
    const { files } = await buildBcfFiles([fullBundle], options('3.0'));
    const path = [...files.keys()].find((p) => p.endsWith('markup.bcf'))!;
    const bad = (files.get(path) as string).replace(/Guid="([0-9a-f-]{36})"/, (_m, g: string) => `Guid="${g.toUpperCase()}"`);
    expect(bad).not.toBe(files.get(path));
    const r = await validateXML({ xml: [{ fileName: path, contents: bad }], schema: [xsd('3.0', 'markup.xsd')], preload: [xsd('3.0', 'shared-types.xsd')] });
    expect(r.valid).toBe(false);
  });
  it('rejects wrong element order in 2.1 markup', async () => {
    const { files } = await buildBcfFiles([fullBundle], options('2.1'));
    const path = [...files.keys()].find((p) => p.endsWith('markup.bcf'))!;
    const bad = (files.get(path) as string).replace(/(\s*<Title>.*<\/Title>)(\s*<Priority>.*<\/Priority>)/, '$2$1');
    expect(bad).not.toBe(files.get(path));
    const r = await validateXML({ xml: [{ fileName: path, contents: bad }], schema: [xsd('2.1', 'markup.xsd')] });
    expect(r.valid).toBe(false);
  });
});

describe.each(['2.1', '3.0'] as const)('container structure BCF %s', (version) => {
  const run = () => buildBcfFiles(allBundles, options(version));

  it('is stable across runs', async () => {
    const a = await run();
    const b = await run();
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [k, v] of a.files) expect(b.files.get(k)).toEqual(v);
  });

  it('uses lowercase GUID folders and task.id as GUID when it is a UUID', async () => {
    const { files } = await run();
    const folders = [...new Set([...files.keys()].filter((p) => p.endsWith('/markup.bcf')).map((p) => p.split('/')[0]!))];
    expect(folders).toHaveLength(allBundles.length);
    for (const f of folders) expect(f).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(folders).toContain(fullBundle.task.id);
    expect(files.get(`${fullBundle.task.id}/markup.bcf`)).toContain(`<Topic Guid="${fullBundle.task.id}"`);
    expect(folders).not.toContain(nonUuidBundle.task.id);
  });

  it('resolves every Viewpoint, Snapshot and DocumentGuid / ReferencedDocument to a file', async () => {
    const { files } = await run();
    const paths = new Set(files.keys());
    let checked = 0;
    for (const [p, c] of files) {
      if (!p.endsWith('/markup.bcf')) continue;
      const dir = p.split('/')[0]!;
      for (const m of (c as string).matchAll(/<(?:Viewpoint|Snapshot)>([^<]+)<\/(?:Viewpoint|Snapshot)>/g)) {
        expect(paths.has(`${dir}/${m[1]}`), `${dir}/${m[1]}`).toBe(true);
        checked++;
      }
      for (const m of (c as string).matchAll(/<DocumentGuid>([^<]+)<\/DocumentGuid>/g)) { expect(paths.has(`Documents/${m[1]}`)).toBe(true); checked++; }
      for (const m of (c as string).matchAll(/<ReferencedDocument>\.\.\/([^<]+)<\/ReferencedDocument>/g)) { expect(paths.has(m[1]!)).toBe(true); checked++; }
    }
    expect(checked).toBeGreaterThan(5);
    if (version === '3.0') {
      for (const m of (files.get('documents.xml') as string).matchAll(/<Document Guid="([^"]+)">/g)) expect(paths.has(`Documents/${m[1]}`)).toBe(true);
    }
  });

  it('writes Labels per version convention', async () => {
    const { files } = await buildBcfFiles([fullBundle], options(version));
    const m = files.get(`${fullBundle.task.id}/markup.bcf`) as string;
    if (version === '2.1') {
      expect((m.match(/<Labels>/g) ?? []).length).toBe(2);
      expect(m).not.toContain('<Label>');
      expect(m).toContain('<Index>1</Index>');
    } else {
      expect((m.match(/<Labels>/g) ?? []).length).toBe(1);
      expect(m).toContain('<Label>Tower A</Label>');
      expect(m).not.toContain('<Index>1</Index>');
    }
  });

  it('round-trips through the zip with directory entries', async () => {
    const res = await exportBcf(allBundles, options(version));
    expect(res.filename).toBe(`freefield-tower-a-2026-11-22-${version === '2.1' ? 'bcf21.bcfzip' : 'bcf30.bcf'}`);
    expect(res.topicCount).toBe(allBundles.length);
    expect(res.blob.type).toBe('application/octet-stream');
    const zip = await JSZip.loadAsync(await res.blob.arrayBuffer());
    const names = Object.keys(zip.files);
    expect(names).toContain('bcf.version');
    expect(names).toContain(`${fullBundle.task.id}/`);
    expect(names).toContain(`${fullBundle.task.id}/markup.bcf`);
    expect(names.every((n) => !n.includes('\\'))).toBe(true);
    const { files } = await buildBcfFiles(allBundles, options(version));
    for (const [p, c] of files) {
      const entry = zip.file(p);
      expect(entry, p).toBeTruthy();
      if (typeof c === 'string') expect(await entry!.async('string')).toBe(c);
      else expect(await entry!.async('uint8array')).toEqual(c);
    }
    const first = await zip.file('bcf.version')!.async('uint8array');
    expect(first[0]).toBe(0x3c); // "<", i.e. no BOM
  });
});

describe('content decisions', () => {
  it('3.0 writes no viewpoint file when the shift is unknown; the snapshot is kept as a document, and it warns', async () => {
    const { files, warnings } = await buildBcfFiles([noShiftBundle], options('3.0', { baseShift: null }));
    expect([...files.keys()].some((p) => p.endsWith('.bcfv'))).toBe(false);
    expect([...files.keys()].some((p) => p.endsWith('snapshot.jpg'))).toBe(false);
    const docsXml = files.get('documents.xml') as string;
    expect(docsXml).toContain('location-snapshot.jpg');
    const markup = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
    expect(markup).not.toContain('<Viewpoints>');
    expect(markup).toContain('Location snapshot');
    expect(warnings.map((w) => w.kind)).toContain('no-3d-view');
  });
  it('2D-only task has no camera and no warning, and keeps the pin in the description', async () => {
    const { files, warnings } = await buildBcfFiles([twoDOnlyBundle], options('3.0'));
    expect([...files.keys()].some((p) => p.endsWith('.bcfv'))).toBe(false);
    expect(warnings).toEqual([]);
    const m3 = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
    expect(m3).not.toContain('<Snapshot>');
    expect(m3).not.toContain('<Viewpoints>');
    expect(m3).toContain('Location snapshot');
  });
  it('2.1 snapshot-only topics get a camera-less viewpoint file so strict readers do not reject the topic', async () => {
    const { files, warnings } = await buildBcfFiles([twoDOnlyBundle], options('2.1'));
    const bcfv = [...files].find(([k]) => k.endsWith('.bcfv'))?.[1] as string;
    expect(bcfv).toContain('<VisualizationInfo');
    expect(bcfv).not.toMatch(/Camera/);
    expect(warnings).toEqual([]);
    const m = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
    expect(m).toContain('<Viewpoint>viewpoint.bcfv</Viewpoint>');
    const markup = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
    expect(markup).toContain('2D pin: Sheet A101');
  });
  it('2.1 snapshot: jpeg without converter is kept with a warning; with converter becomes png', async () => {
    const a = await buildBcfFiles([fullBundle], options('2.1'));
    expect(a.warnings.map((w) => w.kind)).toContain('snapshot-not-png');
    expect([...a.files.keys()]).toContain(`${fullBundle.task.id}/snapshot.jpg`);
    const b = await buildBcfFiles([fullBundle], options('2.1', { convertToPng: async () => pngSnapshot() }));
    expect([...b.files.keys()]).toContain(`${fullBundle.task.id}/snapshot.png`);
    expect(b.warnings.map((w) => w.kind)).not.toContain('snapshot-not-png');
  });
  it('3.0 keeps the jpeg snapshot; a large snapshot warns', async () => {
    const a = await buildBcfFiles([fullBundle, straightDownBundle], options('3.0'));
    expect([...a.files.keys()]).toContain(`${fullBundle.task.id}/snapshot.jpg`);
    expect(a.warnings.filter((w) => w.kind === 'snapshot-downscaled')).toHaveLength(1);
    expect(a.warnings.filter((w) => w.kind === 'snapshot-not-png')).toHaveLength(0);
  });
  it('warns about unresolved elements and skips malformed GUIDs', async () => {
    const b: BcfTaskBundle = { ...fullBundle, components: [...(fullBundle.components ?? []), { ifcGuid: 'short' }] };
    const { files, warnings } = await buildBcfFiles([b], options('3.0'));
    expect(warnings.find((w) => w.kind === 'unresolved-elements')?.message).toContain('2');
    const bcfv = files.get(`${fullBundle.task.id}/viewpoint.bcfv`) as string;
    expect((bcfv.match(/<Component /g) ?? []).length).toBe(3);
  });
  it('3.0 extensions list every value used; documents list photos', async () => {
    const { files } = await buildBcfFiles([fullBundle, minimalBundle], options('3.0'));
    const ext = files.get('extensions.xml') as string;
    expect(ext).toContain('<TopicType>Task</TopicType>');
    expect(ext).toContain('<TopicStatus>Awaiting approval</TopicStatus>');
    expect(ext).toContain('<TopicStatus>Ongoing</TopicStatus>');
    expect(ext).toContain('<Priority>High</Priority>');
    expect(ext).toContain('<TopicLabel>Level 3</TopicLabel>');
    expect(ext).toContain('<User>ana@example.com</User>');
    expect(ext).toContain('<User>bo@example.com</User>');
    const docs = files.get('documents.xml') as string;
    expect((docs.match(/<Document /g) ?? []).length).toBe(2);
    expect(docs).toContain('<Filename>photo-1.jpg</Filename>');
  });
  it('reports progress per topic and supports per-task shift functions', async () => {
    const calls: [number, number][] = [];
    const other: BcfTaskBundle = {
      ...minimalBundle,
      task: { ...minimalBundle.task, id: 'other', cameraPose: { pos: [0, 1, 2], target: [0, 0, 0], fov: 50, isOrtho: false } },
    };
    const { files } = await buildBcfFiles([fullBundle, other], options('3.0', {
      onProgress: (d, n) => calls.push([d, n]),
      baseShift: (id) => (id === fullBundle.task.id ? [100, 20, -50] : null),
    }));
    expect(calls).toEqual([[1, 2], [2, 2]]);
    expect([...files.keys()].filter((p) => p.endsWith('.bcfv'))).toHaveLength(1);
  });
  it('escapes special characters and strips control characters', async () => {
    const { allBundles: _ab, ...rest } = await import('./fixtures');
    void _ab;
    const { files } = await buildBcfFiles([rest.unicodeBundle], options('3.0'));
    const m = [...files].find(([k]) => k.endsWith('markup.bcf'))![1] as string;
    expect(m).toContain('&amp; &lt;b&gt; &quot;q&quot; &apos;a&apos;');
    expect(m).not.toContain('\u0001');
  });
});
