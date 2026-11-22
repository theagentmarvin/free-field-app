/** Tiny XML writer: correct escaping, no namespaces, 2-space indentation. */

// XML 1.0 forbids most C0 controls (tab, LF, CR are fine), U+FFFE/U+FFFF and lone surrogates.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function stripInvalidXmlChars(s: string): string {
  return s.replace(INVALID_XML_CHARS, '');
}

export function escapeText(s: string): string {
  return stripInvalidXmlChars(s)
    .replace(/\r\n?/g, '\n')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function escapeAttr(s: string): string {
  return escapeText(s).replace(/\n/g, '&#10;').replace(/\t/g, '&#9;');
}

export type XAttrs = Record<string, string | number | boolean | null | undefined>;
export type XChild = XNode | null | undefined | false | '';

export interface XNode {
  name: string;
  attrs?: XAttrs;
  /** Text content (mutually exclusive with `children`). */
  text?: string;
  children?: XChild[];
}

/** Element with text content. */
export function xt(name: string, text: string, attrs?: XAttrs): XNode {
  return { name, attrs, text };
}

/** Element with child elements (null/false children are dropped). */
export function xe(name: string, attrs?: XAttrs, children: XChild[] = []): XNode {
  return { name, attrs, children };
}

function attrString(attrs: XAttrs | undefined): string {
  if (!attrs) return '';
  let out = '';
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out += ` ${k}="${escapeAttr(String(v))}"`;
  }
  return out;
}

function render(node: XNode, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  const a = attrString(node.attrs);
  if (node.text !== undefined) {
    out.push(`${pad}<${node.name}${a}>${escapeText(node.text)}</${node.name}>`);
    return;
  }
  const kids = (node.children ?? []).filter((c): c is XNode => !!c);
  if (kids.length === 0) {
    out.push(`${pad}<${node.name}${a}/>`);
    return;
  }
  out.push(`${pad}<${node.name}${a}>`);
  for (const k of kids) render(k, depth + 1, out);
  out.push(`${pad}</${node.name}>`);
}

/** Serialises to a UTF-8 XML document string (no BOM). */
export function serializeXml(root: XNode): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  render(root, 0, out);
  return out.join('\n') + '\n';
}
