// apps/documents/src/compare/cloudPath.ts
//
// SVG path for a scalloped ("revision cloud") outline around a rectangle.
// Each edge is split into equal arcs bulging outward (clockwise winding in
// y-down space, sweep flag 1).

function edgeArcs(len: number, arc: number): number {
  return Math.max(1, Math.round(len / Math.max(1, arc)));
}

export function cloudPath(x: number, y: number, w: number, h: number, arc: number): string {
  const nx = edgeArcs(w, arc);
  const ny = edgeArcs(h, arc);
  const f = (n: number) => Number(n.toFixed(2));
  const parts: string[] = [`M${f(x)} ${f(y)}`];
  const sx = w / nx;
  const sy = h / ny;
  const rx = f(sx / 2);
  const ry = f(sy / 2);
  for (let i = 1; i <= nx; i++) parts.push(`A${rx} ${rx} 0 0 1 ${f(x + sx * i)} ${f(y)}`);
  for (let i = 1; i <= ny; i++) parts.push(`A${ry} ${ry} 0 0 1 ${f(x + w)} ${f(y + sy * i)}`);
  for (let i = 1; i <= nx; i++) parts.push(`A${rx} ${rx} 0 0 1 ${f(x + w - sx * i)} ${f(y + h)}`);
  for (let i = 1; i <= ny; i++) parts.push(`A${ry} ${ry} 0 0 1 ${f(x)} ${f(y + h - sy * i)}`);
  parts.push("Z");
  return parts.join(" ");
}
