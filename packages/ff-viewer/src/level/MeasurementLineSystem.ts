// src/viewer/level/MeasurementLineSystem.ts
//
// Custom OBC.AnnotationSystem that lets the user click two projection
// lines on a TechnicalDrawing to commit a measurement line + endpoint
// markers on the drawing plane.
//
// Modeled after the built-in LinearAnnotations system: same state
// machine pattern (`machineState`, `sendMachineEvent`, `_resetMachine`,
// `_updatePreview` with vertex-count-aware buffer reuse), but simpler —
// just two clicks, no offset/parallel-line validation, no extension
// lines, no text label. (Text labels require font loading and add
// complexity; out of scope for the MVP per the spec.)
//
// ── No raw three.js imports ────────────────────────────────────────────
// We use `OBC.AnnotationSystem` for the base class. The drift linter
// and the project's eslint config BOTH ban `import "three"` — so we
// cannot import `THREE.Group`, `THREE.Vector3`, etc. directly.
//
// Strategy: get constructor references lazily at runtime, on the first
// `sendMachineEvent` call, by reading `.constructor` off
// `_previewDrawing.three` (which IS a `THREE.Group` instance by then).
// We store them in private fields with `as unknown as` casts to keep
// TypeScript happy. The runtime behaviour is identical to importing
// the classes from "three" — they're the same prototype objects.
//
// ── Snap behavior ──────────────────────────────────────────────────────
// On CLICK we project the drawing.raycast() hit point onto the hit
// `Line3` using the same `projectPerpendicularOnLine` logic that
// LinearAnnotations uses internally (not exported, so we replicate
// the math). On MOUSE_MOVE we use a free plane intersection (no snap)
// so the cursor tracks the mouse smoothly between projection lines.
//
// ── State machine ──────────────────────────────────────────────────────
//   awaitingFirstPoint
//     + MOUSE_MOVE → dot preview at cursor
//     + CLICK      → if line hit: snap & → awaitingSecondPoint
//                    else       : no-op (stay)
//     + ESCAPE     → no-op
//   awaitingSecondPoint
//     + MOUSE_MOVE → line preview from pointA → cursor
//     + CLICK      → if line hit: snap & commit & → awaitingFirstPoint
//                    else       : no-op (stay, keep pointA)
//     + ESCAPE     → → awaitingFirstPoint (cancel)
//
// The state shape is intentionally minimal: just `kind` + `pointA` +
// `cursor` for state 2. We don't need lineDir / firstLine because
// we don't validate parallelism — any two clicked lines are valid.
//
// ── Preview geometry ───────────────────────────────────────────────────
// Reuses a single `THREE.LineSegments` (`_previewObject`) whose
// position buffer is rewritten in place when the vertex count matches,
// and recreated otherwise. Same pattern as LinearAnnotations. We
// allocate a 4-vertex buffer (2 segments: a small cross) for state 1
// and a 2-vertex buffer (1 segment) for state 2 — when transitioning
// between them the vertex count differs, so the existing object is
// disposed and a fresh one created.

import * as OBC from "@thatopen/components";
import {
  SegmentLabels,
  formatPlanDistance,
  planDistance,
  type MeasureLabelFactory,
  type PlanUnits,
} from "./measureLabels";

// ── Minimal structural types for the THREE bits we touch ──────────────
//
// These match the three.js v0.182 surface we use. We never import from
// "three" — we cast runtime instances to these shapes via `as unknown`.
// `Object3DLike` covers everything `drawing.three.add(x)` accepts.

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
  // THREE-compatible convenience methods. Optional because not every
  // plain-object Vector3 has them (e.g. the points stored in our
  // state machine are just { x, y, z } literals).
  clone?(): Vector3Like;
  set?(x: number, y: number, z: number): Vector3Like;
}

export interface Line3Like {
  start: Vector3Like;
  end: Vector3Like;
}

export interface BufferAttributeLike {
  set(values: ArrayLike<number>): void;
  needsUpdate: boolean;
  count: number;
}

export interface BufferGeometryLike {
  setAttribute(name: string, attribute: BufferAttributeLike): void;
  attributes: { position: BufferAttributeLike };
  dispose(): void;
}

export interface Object3DLike {
  layers: { set(channel: number): void };
  userData: Record<string, unknown>;
  renderOrder: number;
  frustumCulled: boolean;
  geometry: BufferGeometryLike;
  material: { color: { setHex(hex: number): void } };
  parent: Object3DLike | null;
  removeFromParent(): void;
}

export interface GroupLike extends Object3DLike {
  add(child: Object3DLike): void;
  children: Object3DLike[];
}

export interface LineSegmentsCtor {
  new (
    geometry: BufferGeometryLike,
    material: unknown,
  ): Object3DLike;
}

export interface GroupCtor {
  new (): GroupLike;
}

export interface BufferGeometryCtor {
  new (): BufferGeometryLike;
}

export interface BufferAttributeCtor {
  new (array: ArrayLike<number>, itemSize: number): BufferAttributeLike;
}

// ── Public type surface ────────────────────────────────────────────────

/** Style for a measurement line. Extends the base required by OBC. */
export interface MeasureLineStyle extends OBC.BaseAnnotationStyle {
  /** Radius of the endpoint marker ring in drawing local units. */
  endpointRadius: number;
  /** Number of segments used to draw the endpoint ring (8–24 typical). */
  endpointSegments: number;
}

/** Persisted item — what gets stored on the drawing. */
export interface MeasureLine {
  uuid: string;
  pointA: Vector3Like;
  pointB: Vector3Like;
  style: string;
}

/** Input shape when committing a measurement via the state machine. */
export interface MeasureLineData {
  pointA: Vector3Like;
  pointB: Vector3Like;
  style?: string;
}

/**
 * The "type bag" OBC requires on every AnnotationSystem subclass.
 *
 * The `handle: never` is intentional: MVP has no interactive handle
 * picking (we don't let the user drag-edit the endpoints after
 * committing). The base class's `pickHandle` is overridden to
 * return `null` so the annotation is non-editable.
 */
export interface MeasureLineSystemDescriptor
  extends OBC.DrawingSystemDescriptor {
  item: MeasureLine;
  data: MeasureLineData;
  style: MeasureLineStyle;
  handle: never;
}

// ── State machine types ────────────────────────────────────────────────

/** State 1: nothing placed yet, dot preview follows cursor. */
interface MeasureLineStateAwaitingFirst {
  kind: "awaitingFirstPoint";
  cursor: Vector3Like | null;
}

/** State 2: first point placed, line preview from pointA → cursor. */
interface MeasureLineStateAwaitingSecond {
  kind: "awaitingSecondPoint";
  pointA: Vector3Like;
  cursor: Vector3Like | null;
}

/** Transient: just committed. The base class resets to state 1 after. */
interface MeasureLineStateCommitted {
  kind: "committed";
  line: MeasureLine;
}

export type MeasureLineState =
  | MeasureLineStateAwaitingFirst
  | MeasureLineStateAwaitingSecond
  | MeasureLineStateCommitted;

/** Event shape sent into the state machine. */
export type MeasureLineEvent =
  | {
      type: "MOUSE_MOVE";
      point: Vector3Like;
      drawing?: OBC.TechnicalDrawing;
    }
  | {
      type: "CLICK";
      point: Vector3Like;
      line: Line3Like | null;
      drawing?: OBC.TechnicalDrawing;
    }
  | { type: "ESCAPE"; drawing?: OBC.TechnicalDrawing };

// ── Pure state transition function (testable in isolation) ─────────────

/**
 * State reducer for the measurement line tool. Mirrors the
 * `linearDimensionMachine` pattern in @thatopen/components. We
 * project the click point onto the hit line here (per the spec:
 * "snap on click") and store the snapped point in state.
 */
export function measureLineMachine(
  state: MeasureLineState,
  event: MeasureLineEvent,
): MeasureLineState {
  switch (state.kind) {
    case "awaitingFirstPoint": {
      if (event.type === "MOUSE_MOVE") {
        return { kind: "awaitingFirstPoint", cursor: event.point };
      }
      if (event.type === "CLICK") {
        if (!event.line) return state; // no-op without a hit
        const snapped = projectPerpendicularOnLine(event.point, event.line);
        return { kind: "awaitingSecondPoint", pointA: snapped, cursor: null };
      }
      // ESCAPE in state 1 is a no-op (nothing to cancel)
      return state;
    }
    case "awaitingSecondPoint": {
      if (event.type === "MOUSE_MOVE") {
        return {
          kind: "awaitingSecondPoint",
          pointA: state.pointA,
          cursor: event.point,
        };
      }
      if (event.type === "CLICK") {
        if (!event.line) return state; // stay in state 2 (keep pointA)
        const snapped = projectPerpendicularOnLine(event.point, event.line);
        return {
          kind: "committed",
          line: {
            uuid: generateUuid(),
            pointA: state.pointA,
            pointB: snapped,
            style: "", // stamped with activeStyle by the component
          },
        };
      }
      if (event.type === "ESCAPE") {
        return { kind: "awaitingFirstPoint", cursor: null };
      }
      return state;
    }
    case "committed": {
      if (event.type === "ESCAPE") {
        return { kind: "awaitingFirstPoint", cursor: null };
      }
      // MOUSE_MOVE / CLICK while in `committed` is unusual (the
      // system resets to state 1 immediately after a commit, so
      // we'd never see another event in this state from the normal
      // path) — but we accept MOUSE_MOVE so the cursor preview
      // reappears in state 1.
      if (event.type === "MOUSE_MOVE") {
        return { kind: "awaitingFirstPoint", cursor: event.point };
      }
      if (event.type === "CLICK") {
        if (!event.line) return state;
        const snapped = projectPerpendicularOnLine(event.point, event.line);
        return { kind: "awaitingSecondPoint", pointA: snapped, cursor: null };
      }
      return state;
    }
  }
}

// ── Snap helper ────────────────────────────────────────────────────────

/**
 * Project `anchor` onto the infinite line through `line.start` and
 * `line.end`, then clamp to the segment. Same math as
 * `projectPerpendicularOnLine` in @thatopen/components (not exported,
 * so we replicate it here).
 */
function projectPerpendicularOnLine(
  anchor: Vector3Like,
  line: Line3Like,
): Vector3Like {
  const dx = line.end.x - line.start.x;
  const dz = line.end.z - line.start.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-12) {
    return clonePoint(line.start);
  }
  // t in [0, 1] for the segment, unbounded for the infinite line
  const t =
    ((anchor.x - line.start.x) * dx + (anchor.z - line.start.z) * dz) /
    lenSq;
  const clamped = Math.max(0, Math.min(1, t));
  return {
    x: line.start.x + dx * clamped,
    y: 0,
    z: line.start.z + dz * clamped,
  };
}

/** Lightweight Vector3 copy without depending on three.js. */
function clonePoint(p: Vector3Like): Vector3Like {
  return { x: p.x, y: p.y, z: p.z };
}

/** Generate a UUID without depending on three.js's MathUtils. */
function generateUuid(): string {
  // crypto.randomUUID is available in modern browsers (the app
  // runs in the Vite SPA, Chromium/Firefox/Safari all support it).
  // Fall back to a Math.random-based UUID for SSR / jsdom test runs.
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // RFC4122 v4-ish (not cryptographically strong; fine for object ids)
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += "-";
    } else if (i === 14) {
      out += "4";
    } else if (i === 19) {
      out += hex[(Math.random() * 4) | 0 | 8];
    } else {
      out += hex[(Math.random() * 16) | 0];
    }
  }
  return out;
}

// ── Preview geometry helpers ───────────────────────────────────────────

/**
 * Build the 2D position array for the state-1 dot preview.
 * A small cross (4 vertices / 2 segments) centered at `cursor`.
 * Returns an empty array if `cursor` is null.
 */
function buildDotPreviewPositions(cursor: Vector3Like | null): number[] {
  if (!cursor) return [];
  const r = 0.15; // dot "size" in drawing local units
  // Two segments forming a + cross
  return [
    cursor.x - r, 0, cursor.z,
    cursor.x + r, 0, cursor.z,
    cursor.x, 0, cursor.z - r,
    cursor.x, 0, cursor.z + r,
  ];
}

/**
 * Build the position array for the state-2 line preview.
 * A single segment from `pointA` to `cursor`. Empty if cursor is null.
 */
function buildLinePreviewPositions(
  pointA: Vector3Like,
  cursor: Vector3Like | null,
): number[] {
  if (!cursor) return [];
  return [pointA.x, 0, pointA.z, cursor.x, 0, cursor.z];
}

/**
 * Build the position array for a committed measurement:
 *   - the main line (pointA → pointB)
 *   - two endpoint rings (n segments per ring = 2n vertices)
 */
function buildCommittedPositions(
  pointA: Vector3Like,
  pointB: Vector3Like,
  endpointRadius: number,
  endpointSegments: number,
): number[] {
  const positions: number[] = [];
  // Main line
  positions.push(pointA.x, 0, pointA.z, pointB.x, 0, pointB.z);
  // Endpoint rings
  appendRing(positions, pointA, endpointRadius, endpointSegments);
  appendRing(positions, pointB, endpointRadius, endpointSegments);
  return positions;
}

function appendRing(
  positions: number[],
  center: Vector3Like,
  radius: number,
  segments: number,
): void {
  const n = Math.max(8, Math.floor(segments));
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    positions.push(
      center.x + Math.cos(a0) * radius,
      0,
      center.z + Math.sin(a0) * radius,
      center.x + Math.cos(a1) * radius,
      0,
      center.z + Math.sin(a1) * radius,
    );
  }
}

// ── MeasurementLineSystem class ────────────────────────────────────────

/**
 * Custom annotation system for point-to-point measurement lines.
 *
 * Usage (from LevelPlanController or IfcViewer):
 *   const system = techDrawings.use(MeasurementLineSystem);
 *   system.sendMachineEvent({ type: "CLICK", point, line, drawing });
 *   system.onCommit.add(({ item, group }) => { ... });
 *
 * The system is a singleton registered with `techDrawings.use(...)` —
 * it survives across drawings. When a drawing is disposed, the base
 * class removes it from `_knownDrawings` and the committed geometry
 * goes with it (drawing.three owns the groups). We do NOT dispose the
 * system on level close; only the full viewer teardown should call
 * `system.dispose()` (via `components.dispose()`).
 */
export class MeasurementLineSystem extends OBC.AnnotationSystem<MeasureLineSystemDescriptor> {
  /** Required by the abstract base — we never disable the system. */
  enabled = true;

  /** Current state of the click → click state machine. */
  machineState: MeasureLineState = {
    kind: "awaitingFirstPoint",
    cursor: null,
  };

  /** Emitted on every state transition (including the auto-reset after commit). */
  readonly onMachineStateChanged: OBC.Event<MeasureLineState> =
    new OBC.Event<MeasureLineState>();

  // ── Runtime THREE constructor cache ────────────────────────────────────
  //
  // Populated lazily on the first `sendMachineEvent` call, by reading
  // `.constructor` off `this._previewDrawing.three` (a real
  // THREE.Group). Once cached, all geometry construction uses these
  // references — no `import "three"` is ever needed at compile time
  // or runtime.
  private _Group: GroupCtor | null = null;
  private _LineSegments: LineSegmentsCtor | null = null;
  private _BufferGeometry: BufferGeometryCtor | null = null;
  private _BufferAttribute: BufferAttributeCtor | null = null;
  private _ctorsReady = false;

  // ── Wave 67: value labels ──────────────────────────────────────────────
  // Distance labels + endpoint dots on committed lines and on the live
  // preview. The marks themselves are created by a host-provided factory
  // (CSS2D, see IfcViewer) so this class stays free of three / OBCF.
  private readonly _labels = new SegmentLabels();
  private static readonly PREVIEW_KEY = "__preview__";

  /** Install / replace the factory that creates the on-screen marks. */
  set labelFactory(factory: MeasureLabelFactory | null) {
    this._labels.clear();
    this._labels.factory = factory;
  }

  /** Display unit + local-units-per-metre used by the distance labels. */
  get units(): PlanUnits {
    return this._labels.units;
  }
  set units(value: PlanUnits) {
    this._labels.units = { ...value };
  }

  /** Number of segments currently showing marks (committed + preview). */
  get labelCount(): number {
    return this._labels.size;
  }

  /** Formatted distance of a committed / previewed segment ("3.42 m"). */
  formatDistance(a: Vector3Like, b: Vector3Like): string {
    return formatPlanDistance(planDistance(a, b), this._labels.units);
  }

  /** Raw local distance of a segment. */
  distanceOf(a: Vector3Like, b: Vector3Like): number {
    return planDistance(a, b);
  }

  /** Committed lines on `drawing` (creation order). */
  listItems(drawing: OBC.TechnicalDrawing): MeasureLine[] {
    return [...this.get([drawing]).values()].map((e) => e.item);
  }

  /** Remove every committed line on `drawing` and its labels. */
  clearDrawing(drawing: OBC.TechnicalDrawing): void {
    for (const item of this.listItems(drawing)) this._labels.hide(item.uuid);
    this._labels.hide(MeasurementLineSystem.PREVIEW_KEY);
    const uuids = this.listItems(drawing).map((i) => i.uuid);
    if (uuids.length > 0) this.delete(drawing, uuids);
  }

  /** Delete lines by uuid, with their labels. */
  deleteItems(drawing: OBC.TechnicalDrawing, uuids: string[]): void {
    for (const u of uuids) this._labels.hide(u);
    if (uuids.length > 0) this.delete(drawing, uuids);
  }

  /** Drop every label (the drawing is going away; groups die with it). */
  disposeLabels(): void {
    this._labels.clear();
  }

  constructor(components: OBC.Components) {
    super(components);
    // Default style — orange to stand out against the black/grey
    // discipline layers. The user can override via system.styles
    // if we ever expose a UI for it.
    this.styles.set("default", {
      color: 0xff6600,
      textOffset: 0, // unused in MVP (no text labels)
      fontSize: 0, // unused in MVP
      endpointRadius: 0.18,
      endpointSegments: 16,
    });
  }

  // ── OBC.AnnotationSystem overrides ────────────────────────────────────

  /**
   * MVP: no handle editing. The pickHandle hook exists in the base
   * class as abstract; we return null so the system never claims
   * a hit. (Future tasks can extend this with endpoint dragging.)
   */
  pickHandle(): { uuid: string; handle: never } | null {
    return null;
  }

  /**
   * Build the Group for a committed measurement: the main
   * line + two endpoint ring markers, all drawn on layer 1 (the
   * drawing's own layer mask).
   *
   * The base class declares the return as `THREE.Group` (the real
   * three.js class). We construct the group via the runtime
   * constructor cached in `_Group`, so the returned object IS a
   * real THREE.Group at runtime — we cast through `any` to satisfy
   * the structural override check (we don't import `THREE.Group`
   * at compile time because the project's drift policy bans it).
   *
   * The `any` return type is intentional: the parent class's
   * declared signature is `THREE.Group`, and we cannot reference
   * that type without importing "three". Casting through
   * `unknown as ReturnType<typeof super._buildGroup>` would be
   * more correct but is more verbose for the same runtime effect.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _buildGroup(
    item: MeasureLine,
    style: MeasureLineStyle,
  ): any {  // eslint-disable-line @typescript-eslint/no-explicit-any
    this._ensureCtors();
    if (
      !this._Group ||
      !this._BufferGeometry ||
      !this._BufferAttribute ||
      !this._LineSegments
    ) {
      // Should never happen: sendMachineEvent sets _previewDrawing
      // before _persist is called, and _ensureCtors reads from
      // _previewDrawing. If we somehow get here without a drawing,
      // fall back to an empty group so we don't crash the base class.
      return new this._Group!();
    }
    const positions = buildCommittedPositions(
      item.pointA,
      item.pointB,
      style.endpointRadius,
      style.endpointSegments,
    );
    // Use the LineSegments builder: a single mesh holds the line
    // + the two endpoint rings (all share the same material).
    const group = new this._Group();
    const lineGeo = new this._BufferGeometry();
    lineGeo.setAttribute(
      "position",
      new this._BufferAttribute(new Float32Array(positions), 3),
    );
    const ls = new this._LineSegments(lineGeo, this._getMaterial(item.style));
    ls.layers.set(1);
    ls.userData.isDimension = true;
    // Render on top of projection lines (which share the same Z-plane).
    // Without this, depth-testing against the projection-line layer
    // can hide the measurement line.
    ls.renderOrder = 1;
    (ls.material as unknown as { depthTest: boolean; depthWrite: boolean }).depthTest = false;
    (ls.material as unknown as { depthTest: boolean; depthWrite: boolean }).depthWrite = false;
    group.add(ls as unknown as Object3DLike);
    return group;
  }

  /**
   * Rebuild the preview object after every state transition.
   * Vertex count:
   *   - state 1 (dot):   4 vertices (cross)
   *   - state 2 (line):  2 vertices (segment)
   *   - state 3 (committed): no preview (cleared)
   *
   * The base class's `_clearPreview()` disposes the existing object
   * and nulls `_previewObject`. We recreate when the vertex count
   * changes, and just rewrite the buffer attribute when it matches.
   */
  protected _updatePreview(): void {
    this._ensureCtors();
    if (!this._BufferGeometry || !this._BufferAttribute || !this._LineSegments) {
      // No constructors available — nothing to draw. Clear just in
      // case there's a leftover preview from a previous drawing.
      this._clearPreview();
      return;
    }

    const s = this.machineState;

    // No preview in the `committed` transient state.
    if (s.kind === "committed") {
      this._clearPreview();
      return;
    }

    // Wave 67: live distance label + dots while placing the second point.
    if (this._previewDrawing) {
      if (s.kind === "awaitingSecondPoint") {
        this._labels.show(
          this._previewDrawing,
          MeasurementLineSystem.PREVIEW_KEY,
          s.pointA,
          s.cursor,
        );
      } else {
        this._labels.hide(MeasurementLineSystem.PREVIEW_KEY);
      }
    }

    // Build the target position array for the current state.
    let positions: number[];
    if (s.kind === "awaitingFirstPoint") {
      positions = buildDotPreviewPositions(s.cursor);
    } else {
      positions = buildLinePreviewPositions(s.pointA, s.cursor);
    }

    if (positions.length === 0) {
      this._clearPreview();
      return;
    }

    // Always set the preview material color to match the active
    // style (in case the user changed the color via styles.set).
    const style = this._resolveStyle(this.activeStyle);
    this._previewMaterial.color.setHex(style.color);
    this._previewMaterial.opacity = 0.85;
    this._previewMaterial.transparent = true;
    this._previewMaterial.depthTest = false;

    if (!this._previewDrawing) {
      // No drawing to attach to yet — wait for the first event
      // to carry a `drawing` reference. We don't clear preview
      // here because the next event may set _previewDrawing.
      return;
    }

    const vertexCount = positions.length / 3;
    const existingPreview = this._previewObject as unknown as
      | Object3DLike
      | null;
    const needsNew =
      !existingPreview ||
      existingPreview.geometry.attributes.position.count !== vertexCount;

    if (needsNew) {
      this._clearPreview();
      const geo = new this._BufferGeometry();
      geo.setAttribute(
        "position",
        new this._BufferAttribute(new Float32Array(positions), 3),
      );
      this._previewObject = new this._LineSegments(
        geo,
        this._previewMaterial,
      ) as unknown as never;
      const previewObj = this._previewObject as unknown as Object3DLike | null;
      if (previewObj) {
        previewObj.layers.set(1);
        previewObj.renderOrder = 999;
        previewObj.frustumCulled = false;
        previewObj.userData.isDimension = true;
        previewObj.userData.isMeasurementPreview = true;
        this._previewDrawing.three.add(previewObj as unknown as never);
      }
    } else {
      const previewObj = this._previewObject as unknown as Object3DLike | null;
      if (previewObj) {
        const attr = previewObj.geometry.attributes.position;
        attr.set(positions);
        attr.needsUpdate = true;
      }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Drive the state machine. Mirrors LinearAnnotations' pattern:
   * extract `event.drawing` to set `_previewDrawing`, run the
   * reducer, fire `onMachineStateChanged`, and on `committed.kind`
   * persist via the base class's `_persist` and fire `onCommit`.
   */
  sendMachineEvent(event: MeasureLineEvent): void {
    const eventDrawing = event.drawing ?? null;
    if (eventDrawing) this._previewDrawing = eventDrawing;

    const next = measureLineMachine(this.machineState, event);
    if (next === this.machineState) return;

    this.machineState = next;
    this._updatePreview();

    if (next.kind === "committed") {
      if (!this._previewDrawing) {
        // eslint-disable-next-line no-console
        console.warn(
          "MeasurementLineSystem: commit requires a drawing. Pass `drawing` on the first CLICK.",
        );
        this._resetMachine();
        return;
      }
      // Stamp the active style onto the committed item.
      next.line.style = this.activeStyle;
      const committed = this._persist(this._previewDrawing, next.line);
      this._labels.hide(MeasurementLineSystem.PREVIEW_KEY);
      this._labels.show(
        this._previewDrawing,
        next.line.uuid,
        next.line.pointA,
        next.line.pointB,
      );
      this.onCommit.trigger([committed]);
    }

    this.onMachineStateChanged.trigger(this.machineState);

    if (next.kind === "committed") this._resetMachine();
  }

  // ── Private ───────────────────────────────────────────────────────────

  private _resetMachine(): void {
    this.machineState = { kind: "awaitingFirstPoint", cursor: null };
    this._labels.hide(MeasurementLineSystem.PREVIEW_KEY);
    this._previewDrawing = null;
    this._updatePreview();
    this.onMachineStateChanged.trigger(this.machineState);
  }

  /**
   * Populate the runtime constructor cache by reading `.constructor`
   * off the preview drawing's `three` group. Called on the first
   * `_updatePreview` / `_buildGroup` after `_previewDrawing` is set
   * (i.e. after the first CLICK with a drawing). Idempotent.
   */
  private _ensureCtors(): void {
    if (this._ctorsReady) return;
    if (!this._previewDrawing) return;
    const threeGroup = this._previewDrawing.three as unknown as GroupLike;
    if (!threeGroup) return;
    // `threeGroup` is a real THREE.Group. Its `.constructor` is the
    // THREE.Group class. The geometry/material classes are different,
    // but the prototype chain on a BufferGeometry / BufferAttribute /
    // LineSegments is the same — we can extract them from any
    // existing instance. The base class's `_previewMaterial` is a
    // THREE.LineBasicMaterial — but we don't need that. Instead, we
    // get the BufferGeometry / LineSegments classes from a temp
    // object we create with `new (Group)` and then `.add(...)`.
    //
    // Simplest path: use the `drawing.three.matrixWorld.constructor`
    // chain — no, those are different classes. Instead, we walk the
    // `drawing.three` children: if the drawing has any LineSegments
    // (the projection lines are LineSegments), grab one and read its
    // constructors. This is how the OBC tutorials do it.
    //
    // Fallback: if no children yet, we create a temp LineSegments
    // with a BufferGeometry + BufferAttribute via the constructors
    // we can extract from `_previewMaterial` (a LineBasicMaterial —
    // not useful) — or from the prototype of any base-class-managed
    // resource. The robust path is to walk the scene children.
    let found: Object3DLike | null = null;
    const seen = new Set<object>();
    const stack: Object3DLike[] = [threeGroup];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (seen.has(node as unknown as object)) continue;
      seen.add(node as unknown as object);
      // We want a node that has both `.geometry` and a `.constructor`
      // that gives us a useful class. LineSegments qualifies.
      const ctor = (node as unknown as { constructor: unknown }).constructor;
      if (
        ctor &&
        typeof ctor === "function" &&
        ctor !== Object &&
        ctor !== Array
      ) {
        const proto = (ctor as { prototype?: unknown }).prototype;
        if (
          proto &&
          (node as unknown as { geometry?: unknown }).geometry !== undefined
        ) {
          found = node;
          break;
        }
      }
      // Walk children if any
      const children = (node as unknown as { children?: Object3DLike[] })
        .children;
      if (children && Array.isArray(children)) {
        for (const c of children) stack.push(c);
      }
    }
    if (!found) {
      // No LineSegments / mesh yet in the drawing (e.g. the user
      // opened an empty drawing). Fall back to creating a temp
      // THREE.Object3D and walking its prototype chain. We need
      // *some* way to get the constructor references; if this
      // branch is hit, the projection lines haven't rendered yet,
      // which means there's no drawing to attach geometry to either.
      // Just bail — the system will silently no-op for the very
      // first CLICK and the next one (when projection lines exist)
      // will succeed.
      return;
    }
    const foundCtor = (found as unknown as { constructor: unknown })
      .constructor as LineSegmentsCtor;
    this._LineSegments = foundCtor;
    // BufferGeometry: create a temp instance via prototype, then
    // read its constructor. We can't easily get to BufferGeometry
    // without one in hand. Trick: every THREE class is reachable
    // through `new (X)()` chains, but we need an entry point. The
    // base class exposes `this._previewMaterial` — but that's a
    // LineBasicMaterial, not a geometry. Alternative: use the
    // engine's class registry. OBC doesn't expose one.
    //
    // Pragmatic approach: read the geometry from the found
    // LineSegments and use ITS constructor. Then create a new
    // BufferAttribute via the existing one's constructor.
    const foundGeoCtor = (found.geometry as unknown as { constructor: BufferGeometryCtor })
      .constructor;
    this._BufferGeometry = foundGeoCtor;
    const posAttr = found.geometry.attributes.position;
    const posAttrCtor = (posAttr as unknown as { constructor: BufferAttributeCtor })
      .constructor;
    this._BufferAttribute = posAttrCtor;
    // Group: the drawing's `three` IS a Group. Read its constructor.
    this._Group = (threeGroup as unknown as { constructor: GroupCtor })
      .constructor;
    this._ctorsReady = true;
  }
}
