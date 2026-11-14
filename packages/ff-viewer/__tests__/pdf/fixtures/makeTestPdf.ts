// Wave 64 — tiny hand-written PDF fixture (no pdf-lib in the repo).
//
// `makeTestPdf([[612, 792], [792, 612]])` returns the bytes of a valid
// PDF 1.4 file with one page per entry (MediaBox width × height, in
// points), each holding a filled rectangle. The xref offsets are
// computed, so PDF.js parses it without any repair.

export function makeTestPdf(pages: ReadonlyArray<readonly [number, number]>): Uint8Array {
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = pages.map((_, i) => 3 + i * 2);
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  pages.forEach(([w, h], i) => {
    const id = pageIds[i]!;
    const content = `0 0 1 rg 10 10 ${w - 20} ${h - 20} re f`;
    objs[id] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Contents ${id + 1} 0 R /Resources << >> >>`;
    objs[id + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** The standard 2-page fixture: portrait Letter, then landscape Letter. */
export const TWO_PAGE_SIZES = [
  [612, 792],
  [792, 612],
] as const;
