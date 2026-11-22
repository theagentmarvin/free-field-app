import type { RasterPage } from "../../src/compare/types";

export function blank(w: number, h: number): RasterPage {
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) };
}

export function rect(p: RasterPage, x: number, y: number, w: number, h: number, v = 0): RasterPage {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= p.width || yy >= p.height) continue;
      const i = (yy * p.width + xx) * 4;
      p.data[i] = v;
      p.data[i + 1] = v;
      p.data[i + 2] = v;
      p.data[i + 3] = 255;
    }
  }
  return p;
}

export function rectRGB(
  p: RasterPage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
): RasterPage {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= p.width || yy >= p.height) continue;
      const i = (yy * p.width + xx) * 4;
      p.data[i] = rgb[0];
      p.data[i + 1] = rgb[1];
      p.data[i + 2] = rgb[2];
      p.data[i + 3] = 255;
    }
  }
  return p;
}
