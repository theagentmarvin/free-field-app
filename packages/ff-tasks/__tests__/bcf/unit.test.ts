import { describe, expect, it } from 'vitest';
import { cameraToBcf, formatNumber } from '../../src/bcf/camera';
import { guidFor, isUuid, sha1, uuidv5 } from '../../src/bcf/guid';
import { readImageSize } from '../../src/bcf/imageInfo';
import { BCF_STATUS_LABELS } from '../../src/bcf/labels';
import { escapeAttr, escapeText, serializeXml, stripInvalidXmlChars, xe, xt } from '../../src/bcf/xml';
import { buildDescription, commentText, imageExtension, toBcfDate } from '../../src/bcf/writer';
import { fakeJpeg, fullBundle, PNG_1x1, minimalBundle } from './fixtures';

describe('labels', () => {
  it('pins the FreeField status labels', () => {
    expect(BCF_STATUS_LABELS).toEqual({
      10: 'Inbox', 20: 'Ongoing', 30: 'Rejected', 40: 'Awaiting approval', 60: 'Follow-up', 65: 'Approved', 80: 'Discontinued',
    });
  });
});

describe('cameraToBcf', () => {
  it('maps a known pose to IFC coordinates', () => {
    // world = (ifcX, ifcZ, -ifcY) + shift ; shift (100,20,-50); IFC pos (5, 7, 3) -> world (105, 23, -57)
    const cam = cameraToBcf({ pos: [105, 23, -57], target: [105, 23, -58], fov: 50, isOrtho: false }, [100, 20, -50], '3.0', 2);
    expect(cam.viewPoint).toEqual([5, 7, 3]);
    // looking along world -Z == IFC +Y
    expect(cam.direction[0]).toBeCloseTo(0);
    expect(cam.direction[1]).toBeCloseTo(1);
    expect(cam.direction[2]).toBeCloseTo(0);
    // up is world +Y == IFC +Z
    expect(cam.up).toEqual([0, 0, 1]);
    expect(cam.kind).toBe('perspective');
    expect(cam.aspectRatio).toBe(2);
  });
  it('gives a valid (non-parallel) up for a straight-down view', () => {
    const cam = cameraToBcf({ pos: [0, 10, 0], target: [0, 0, 0], fov: 50, isOrtho: false }, [0, 0, 0], '2.1');
    expect(cam.direction).toEqual([0, 0, -1]);
    expect(cam.up).toEqual([0, 1, 0]); // north
    const d = cam.direction, u = cam.up;
    expect(Math.abs(d[0] * u[0] + d[1] * u[1] + d[2] * u[2])).toBeLessThan(1e-9);
    const up = cameraToBcf({ pos: [0, 0, 0], target: [0, 10, 0], fov: 50, isOrtho: false }, [0, 0, 0], '2.1');
    expect(up.direction).toEqual([0, 0, 1]);
    expect(up.up).toEqual([0, 1, 0]);
  });
  it('clamps fov in 2.1 only, and omits AspectRatio there', () => {
    const p = { pos: [0, 0, 5], target: [0, 0, 0], isOrtho: false } as const;
    expect(cameraToBcf({ ...p, fov: 30 }, [0, 0, 0], '2.1').fieldOfView).toBe(45);
    expect(cameraToBcf({ ...p, fov: 90 }, [0, 0, 0], '2.1').fieldOfView).toBe(60);
    expect(cameraToBcf({ ...p, fov: 90 }, [0, 0, 0], '3.0').fieldOfView).toBe(90);
    expect(cameraToBcf({ ...p, fov: 90 }, [0, 0, 0], '2.1').aspectRatio).toBeUndefined();
    expect(cameraToBcf({ ...p, fov: 0 }, [0, 0, 0], '3.0').fieldOfView).toBe(45);
  });
  it('gives an ortho pose a ViewToWorldScale', () => {
    const cam = cameraToBcf({ pos: [0, 10, 0], target: [0, 0, 0], fov: 45, isOrtho: true }, [0, 0, 0], '3.0');
    expect(cam.kind).toBe('orthogonal');
    expect(cam.viewToWorldScale).toBeCloseTo(2 * 10 * Math.tan((45 * Math.PI) / 360), 5);
    expect(cam.fieldOfView).toBeUndefined();
  });
  it('formats numbers without exponent or -0', () => {
    expect(formatNumber(-0)).toBe('0');
    expect(formatNumber(-0.0000001)).toBe('0');
    expect(formatNumber(1e-7)).toBe('0');
    expect(formatNumber(1.5)).toBe('1.5');
    expect(formatNumber(1e21)).not.toMatch(/e/i);
    expect(formatNumber(1 / 3)).toBe('0.333333');
    expect(formatNumber(NaN)).toBe('0');
  });
});

describe('guid', () => {
  it('matches the RFC 4122 uuid v5 reference vector', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  it('sha1 reference vector', () => {
    const hex = Array.from(sha1(new TextEncoder().encode('abc')), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(hex).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });
  it('is stable, lowercase and UUID-shaped', () => {
    expect(guidFor('task', 'abc')).toBe(guidFor('task', 'abc'));
    expect(guidFor('task', 'abc')).not.toBe(guidFor('entry', 'abc'));
    expect(isUuid(guidFor('task', 'abc'))).toBe(true);
    expect(guidFor('task', '3F2504E0-4F89-41D3-9A0C-0305E82C3301')).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });
});

describe('xml', () => {
  it('escapes text and attributes', () => {
    expect(escapeText(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(escapeAttr('a\nb"')).toBe('a&#10;b&quot;');
  });
  it('strips invalid control characters but keeps tab, LF, CR', () => {
    expect(stripInvalidXmlChars('a\u0000b\u0001c\td\ne\rf￾')).toBe('abc\td\ne\rf');
    expect(stripInvalidXmlChars('x\uD800y')).toBe('xy');
    expect(stripInvalidXmlChars('\u{1F600}')).toBe('\u{1F600}');
  });
  it('serialises without BOM and with empty elements self-closed', () => {
    const s = serializeXml(xe('A', { k: 'v&' }, [xt('B', '1 < 2'), xe('C')]));
    expect(s.charCodeAt(0)).toBe(0x3c);
    expect(s).toContain('<A k="v&amp;">');
    expect(s).toContain('<B>1 &lt; 2</B>');
    expect(s).toContain('<C/>');
  });
});

describe('image dimensions', () => {
  it('reads PNG IHDR', () => expect(readImageSize(PNG_1x1)).toEqual({ width: 1, height: 1 }));
  it('reads JPEG SOF', () => expect(readImageSize(fakeJpeg(1600, 900))).toEqual({ width: 1600, height: 900 }));
  it('returns null for garbage', () => {
    expect(readImageSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(readImageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});

describe('text mapping', () => {
  const e = (action: string, text = '', from: number | null = null, to: number | null = null) =>
    ({ id: 'x', action, text, by: 'a', byUid: 'a', at: 0, statusFrom: from, statusTo: to });
  it('maps activity to comment text, never empty', () => {
    expect(commentText(e('create'))).toBe('Created');
    expect(commentText(e('complete', 'ok', 20, 40))).toBe('Status: Ongoing → Awaiting approval\nok');
    expect(commentText(e('approve', '', 40, 65))).toBe('Status: Awaiting approval → Approved');
    expect(commentText(e('reject'))).toBe('Rejected');
    expect(commentText(e('edit', 'new title'))).toBe('Edited\nnew title');
    expect(commentText(e('comment', 'hi'))).toBe('hi');
    expect(commentText(e('comment', '  '))).toBe('Comment');
  });
  it('builds the description block', () => {
    const d = buildDescription(fullBundle)!;
    expect(d.startsWith('Cracks near the support.\n\nFreeField\nTask T001\n')).toBe(true);
    expect(d).toContain('Building: Tower A');
    expect(d).toContain('Sheets: A101 (v3, p.1), S200');
    expect(d).toContain('[x] Photograph');
    expect(d).toContain('[ ] Notify engineer');
    expect(buildDescription(minimalBundle)).toBe('FreeField\nTask T002');
  });
  it('formats dates and extensions', () => {
    expect(toBcfDate(Date.UTC(2026, 4, 2, 9, 15, 0, 123))).toBe('2026-05-02T09:15:00Z');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/heic')).toBe('heic');
    expect(imageExtension('image/webp')).toBe('webp');
  });
});
