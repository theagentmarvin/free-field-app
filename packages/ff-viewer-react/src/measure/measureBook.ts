// packages/ff-viewer-react/src/measure/measureBook.ts
//
// Wave 67: the measurements list model. Turns the OBCF measurement
// components' `list` DataSets (Line / Area / Angle / Volume items) into a
// flat, ordered, serialisable list of entries for the UI, and answers the
// per-item questions the viewer needs (focus bounds, visual to highlight).
// Engine objects are typed structurally so this stays testable with fakes.

import {
  DEFAULT_MEASURE_UNITS,
  MEASURE_VARIANT_LABELS,
  formatMeasureValue,
  type MeasureVariant,
} from "./measureFormat";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Structural view of one component's items + visuals. */
export interface BookComponent {
  list?: Iterable<unknown> | undefined;
  units?: string;
  lines?: Iterable<unknown>;
  fills?: Iterable<unknown>;
  volumes?: Iterable<unknown>;
  color?: unknown;
}

export interface BookSource {
  variant: MeasureVariant;
  component: BookComponent;
}

/** One row of the measurements list (plain data, safe to hand to React). */
export interface MeasurementEntry {
  id: string;
  variant: MeasureVariant;
  /** "Length 2" - per-variant creation ordinal. */
  label: string;
  /** Value in `unit`, or null while an async value (volume) is pending. */
  value: number | null;
  unit: string;
  /** Formatted value with unit symbol ("3.42 m"); "…" while pending. */
  text: string;
}

interface ItemLike {
  id?: unknown;
  value?: unknown;
  start?: Vec3;
  end?: Vec3;
  vertex?: Vec3;
  points?: Iterable<Vec3>;
  getValue?: () => Promise<number>;
  getBox?: () => Promise<{ min: Vec3; max: Vec3 }>;
}

interface Seen {
  seq: number;
  ordinal: number;
  id: string;
}

export interface FocusBounds {
  center: Vec3;
  /** Half the bounding-box diagonal (> 0). */
  radius: number;
}

/** Bounds of a point cloud; null for none. */
export function boundsOfPoints(points: Vec3[]): FocusBounds | null {
  if (points.length === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (![p.x, p.y, p.z].every(Number.isFinite)) continue;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  if (!Number.isFinite(minX)) return null;
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
    radius: Math.max(Math.hypot(dx, dy, dz) / 2, 0.25),
  };
}

export class MeasurementBook {
  private readonly seen = new WeakMap<object, Seen>();
  private readonly volumeValues = new WeakMap<object, number>();
  private readonly volumePending = new WeakSet<object>();
  private seq = 0;
  private readonly ordinals: Record<MeasureVariant, number> = {
    length: 0,
    area: 0,
    angle: 0,
    volume: 0,
  };

  /** Called when an async value (volume) resolves; the owner re-snapshots. */
  onValueResolved: (() => void) | null = null;

  private touch(variant: MeasureVariant, item: object): Seen {
    let s = this.seen.get(item);
    if (!s) {
      this.seq += 1;
      this.ordinals[variant] += 1;
      const raw = (item as ItemLike).id;
      s = {
        seq: this.seq,
        ordinal: this.ordinals[variant],
        id: typeof raw === "string" && raw ? raw : `${variant}-${this.seq}`,
      };
      this.seen.set(item, s);
    }
    return s;
  }

  private valueOf(variant: MeasureVariant, item: ItemLike): number | null {
    if (variant === "volume") {
      const cached = this.volumeValues.get(item);
      if (cached !== undefined) return cached;
      if (typeof item.getValue === "function" && !this.volumePending.has(item)) {
        this.volumePending.add(item);
        void item
          .getValue()
          .then((v) => {
            if (typeof v === "number" && Number.isFinite(v)) {
              this.volumeValues.set(item, v);
              this.onValueResolved?.();
            }
          })
          .catch(() => undefined);
      }
      return null;
    }
    return typeof item.value === "number" && Number.isFinite(item.value)
      ? item.value
      : null;
  }

  /** Ordered (creation order across variants) list of every measurement. */
  snapshot(sources: Iterable<BookSource>): MeasurementEntry[] {
    const rows: Array<{ seq: number; entry: MeasurementEntry }> = [];
    for (const { variant, component } of sources) {
      const list = component.list;
      if (!list || typeof list[Symbol.iterator] !== "function") continue;
      const unit = component.units ?? DEFAULT_MEASURE_UNITS[variant];
      for (const raw of list) {
        if (raw === null || typeof raw !== "object") continue;
        const item = raw as ItemLike;
        const s = this.touch(variant, item);
        const value = this.valueOf(variant, item);
        rows.push({
          seq: s.seq,
          entry: {
            id: s.id,
            variant,
            label: `${MEASURE_VARIANT_LABELS[variant]} ${s.ordinal}`,
            value,
            unit,
            text: value === null ? "…" : formatMeasureValue(value, unit),
          },
        });
      }
    }
    rows.sort((a, b) => a.seq - b.seq);
    return rows.map((r) => r.entry);
  }

  /** The source + raw item behind an entry id. */
  find(
    sources: Iterable<BookSource>,
    id: string,
  ): { variant: MeasureVariant; component: BookComponent; item: ItemLike } | null {
    for (const { variant, component } of sources) {
      const list = component.list;
      if (!list || typeof list[Symbol.iterator] !== "function") continue;
      for (const raw of list) {
        if (raw === null || typeof raw !== "object") continue;
        if (this.touch(variant, raw).id === id) {
          return { variant, component, item: raw as ItemLike };
        }
      }
    }
    return null;
  }
}

/** Points that frame a measurement (Volume uses `focusBoundsAsync`). */
export function itemPoints(variant: MeasureVariant, item: ItemLike): Vec3[] {
  switch (variant) {
    case "length":
      return item.start && item.end ? [item.start, item.end] : [];
    case "angle":
      return item.start && item.vertex && item.end
        ? [item.start, item.vertex, item.end]
        : [];
    case "area":
      return item.points ? [...item.points] : [];
    case "volume":
      return [];
  }
}

/** Camera-framing bounds for an item (volume reads its async box). */
export async function focusBoundsAsync(
  variant: MeasureVariant,
  item: ItemLike,
): Promise<FocusBounds | null> {
  if (variant === "volume") {
    try {
      const box = await item.getBox?.();
      return box ? boundsOfPoints([box.min, box.max]) : null;
    } catch {
      return null;
    }
  }
  return boundsOfPoints(itemPoints(variant, item));
}

/** The DOM element of a measurement's value label (highlight target). */
type LabelHost = { label?: { three?: { element?: HTMLElement } } };

/**
 * The value-label elements a list item owns, so the viewer can mark them
 * as active (CSS ring) for highlight. Dimension lines / fills / volumes
 * are matched by the item they were built from; angle visuals live in the
 * engine's `_visuals` Map keyed by the item.
 */
export function labelElementsOf(
  variant: MeasureVariant,
  component: BookComponent & { _visuals?: Map<unknown, LabelHost> },
  item: object,
): HTMLElement[] {
  const hosts: LabelHost[] = [];
  const pick = (set: Iterable<unknown> | undefined, key: string): void => {
    if (!set) return;
    for (const v of set) {
      if ((v as Record<string, unknown>)[key] === item) hosts.push(v as LabelHost);
    }
  };
  switch (variant) {
    case "length":
      pick(component.lines, "line");
      break;
    case "area":
      pick(component.fills, "area");
      break;
    case "volume":
      pick(component.volumes, "volume");
      break;
    case "angle": {
      const v = component._visuals?.get(item);
      if (v) hosts.push(v);
      break;
    }
  }
  const out: HTMLElement[] = [];
  for (const h of hosts) {
    const el = h.label?.three?.element;
    if (el) out.push(el);
  }
  return out;
}
