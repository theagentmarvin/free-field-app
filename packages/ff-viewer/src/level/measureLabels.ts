// packages/ff-viewer/src/level/measureLabels.ts
//
// Wave 67: value labels + endpoint dots for the 2D level-plan measure
// tool. Pure (no three / OBC imports): the host (IfcViewer) supplies a
// `MeasureLabelFactory` that creates the actual CSS2D marks, so this
// module is unit-testable and keeps the drift linter happy.

import type { Vector3Like } from "./MeasurementLineSystem";

/** A created on-screen mark (label or dot). */
export interface MeasureMarkHandle {
  setText(text: string): void;
  /** Drawing-local position. */
  setPosition(p: Vector3Like): void;
  dispose(): void;
}

/** Host-provided factory; `drawing` is opaque to this module. */
export interface MeasureLabelFactory {
  create(
    drawing: unknown,
    kind: "label" | "dot",
    position: Vector3Like,
    text?: string,
  ): MeasureMarkHandle | null;
}

/** Display units for plan measurements. */
export type PlanLengthUnit = "m" | "cm" | "mm";

/** How drawing-local units map to metres, and what unit to display. */
export interface PlanUnits {
  /** Display unit. Default "m". */
  unit: PlanLengthUnit;
  /** Drawing-local units per metre (1 for a metre-based model). */
  localPerMetre: number;
}

export const DEFAULT_PLAN_UNITS: PlanUnits = { unit: "m", localPerMetre: 1 };

const UNIT_PER_METRE: Record<PlanLengthUnit, number> = { m: 1, cm: 100, mm: 1000 };
const UNIT_DIGITS: Record<PlanLengthUnit, number> = { m: 2, cm: 1, mm: 0 };

/** Horizontal (XZ) distance between two drawing-local points. */
export function planDistance(a: Vector3Like, b: Vector3Like): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Convert a drawing-local distance to the display unit. */
export function planDistanceInUnit(local: number, units: PlanUnits): number {
  const perMetre = units.localPerMetre > 0 ? units.localPerMetre : 1;
  return (local / perMetre) * UNIT_PER_METRE[units.unit];
}

/** "3.42 m" - same rules as the 3D tools' formatter. */
export function formatPlanDistance(
  local: number,
  units: PlanUnits = DEFAULT_PLAN_UNITS,
): string {
  const v = planDistanceInUnit(local, units);
  if (!Number.isFinite(v)) return "—";
  let text = v.toFixed(UNIT_DIGITS[units.unit]);
  if (/^-0(\.0+)?$/.test(text)) text = text.slice(1);
  return `${text} ${units.unit}`;
}

/** Midpoint of a segment in the drawing plane (y = 0). */
export function planMidpoint(a: Vector3Like, b: Vector3Like): Vector3Like {
  return { x: (a.x + b.x) / 2, y: 0, z: (a.z + b.z) / 2 };
}

interface Bundle {
  label: MeasureMarkHandle | null;
  dotA: MeasureMarkHandle | null;
  dotB: MeasureMarkHandle | null;
}

/**
 * Owns the marks of a set of segments, keyed by id. `show` creates or
 * moves them; `hide` / `clear` dispose them.
 */
export class SegmentLabels {
  factory: MeasureLabelFactory | null = null;
  units: PlanUnits = { ...DEFAULT_PLAN_UNITS };
  private readonly bundles = new Map<string, Bundle>();

  get size(): number {
    return this.bundles.size;
  }

  /**
   * Show a segment with a distance label at its midpoint and a dot on each
   * end. `dotB` is omitted for a preview that has no second point yet.
   */
  show(
    drawing: unknown,
    key: string,
    a: Vector3Like,
    b: Vector3Like | null,
  ): void {
    const factory = this.factory;
    if (!factory) return;
    let bundle = this.bundles.get(key);
    if (!bundle) {
      bundle = { label: null, dotA: null, dotB: null };
      this.bundles.set(key, bundle);
    }
    const flat = (p: Vector3Like): Vector3Like => ({ x: p.x, y: 0, z: p.z });
    if (bundle.dotA) bundle.dotA.setPosition(flat(a));
    else bundle.dotA = factory.create(drawing, "dot", flat(a));
    if (!b) {
      bundle.label?.dispose();
      bundle.label = null;
      bundle.dotB?.dispose();
      bundle.dotB = null;
      return;
    }
    const text = formatPlanDistance(planDistance(a, b), this.units);
    const mid = planMidpoint(a, b);
    if (bundle.label) {
      bundle.label.setText(text);
      bundle.label.setPosition(mid);
    } else {
      bundle.label = factory.create(drawing, "label", mid, text);
    }
    if (bundle.dotB) bundle.dotB.setPosition(flat(b));
    else bundle.dotB = factory.create(drawing, "dot", flat(b));
  }

  hide(key: string): void {
    const bundle = this.bundles.get(key);
    if (!bundle) return;
    bundle.label?.dispose();
    bundle.dotA?.dispose();
    bundle.dotB?.dispose();
    this.bundles.delete(key);
  }

  clear(): void {
    for (const key of [...this.bundles.keys()]) this.hide(key);
  }
}
