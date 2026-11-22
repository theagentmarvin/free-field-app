import type { BcfCameraPose, BcfVersion, Vec3 } from './types';

/**
 * FreeField world is three.js (Y-up, metres) with the base model shifted to the origin:
 *   world = (ifcX, ifcZ, -ifcY) + shift
 * so ifcX = wx - sx, ifcY = -(wz - sz), ifcZ = wy - sy. Directions use the axis swap only.
 */

export interface BcfCamera {
  kind: 'perspective' | 'orthogonal';
  viewPoint: Vec3;
  direction: Vec3;
  up: Vec3;
  /** Perspective only (degrees; clamped to [45, 60] in 2.1). */
  fieldOfView?: number;
  /** Orthogonal only (visible vertical size, metres). */
  viewToWorldScale?: number;
  /** 3.0 only. */
  aspectRatio?: number;
}

const EPS = 1e-6;
const DEFAULT_ORTHO_FOV = 45;
const DEFAULT_ASPECT = 16 / 9;

const round6 = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return Object.is(r, -0) || r === 0 ? 0 : r;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.sqrt(dot(a, a));
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3): Vec3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : scale(a, 1 / l);
};
/** world (x,y,z) direction -> IFC (x, -z, y). */
const dirToIfc = (d: Vec3): Vec3 => [d[0], -d[2], d[1]];

function projectPerp(v: Vec3, dir: Vec3): Vec3 | null {
  const p = sub(v, scale(dir, dot(v, dir)));
  return len(p) < EPS ? null : norm(p);
}

/** Formats a number: up to 6 decimals, no exponent, no "-0". */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const r = round6(n);
  if (r === 0) return '0';
  if (Math.abs(r) >= 1e21) return BigInt(r).toString();
  let s = r.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function cameraToBcf(
  pose: BcfCameraPose,
  shift: Vec3,
  version: BcfVersion,
  aspect: number = DEFAULT_ASPECT,
): BcfCamera {
  const worldPos = pose.pos;
  const viewPoint: Vec3 = [worldPos[0] - shift[0], -(worldPos[2] - shift[2]), worldPos[1] - shift[1]];

  let dirW = norm(sub(pose.target, pose.pos));
  if (len(dirW) < EPS) dirW = [0, 0, -1]; // pos == target: look "north" horizontally
  // Up: world +Y projected perpendicular to the direction; straight up/down falls back to world -Z.
  const upW = projectPerp([0, 1, 0], dirW) ?? projectPerp([0, 0, -1], dirW) ?? [0, 1, 0];

  const direction = dirToIfc(dirW);
  const up = dirToIfc(upW);
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;

  const base = {
    viewPoint: viewPoint.map(round6) as unknown as Vec3,
    direction: direction.map(round6) as unknown as Vec3,
    up: up.map(round6) as unknown as Vec3,
  };

  if (pose.isOrtho) {
    const fov = pose.fov > 0 && pose.fov < 180 ? pose.fov : DEFAULT_ORTHO_FOV;
    const dist = len(sub(pose.target, pose.pos));
    const s = 2 * dist * Math.tan((fov * Math.PI) / 360);
    const cam: BcfCamera = {
      kind: 'orthogonal',
      ...base,
      viewToWorldScale: round6(s > EPS ? s : 1),
    };
    if (version === '3.0') cam.aspectRatio = round6(asp);
    return cam;
  }

  let fov = Number.isFinite(pose.fov) && pose.fov > 0 && pose.fov < 180 ? pose.fov : 45;
  if (version === '2.1') fov = Math.min(60, Math.max(45, fov));
  const cam: BcfCamera = { kind: 'perspective', ...base, fieldOfView: round6(fov) };
  if (version === '3.0') cam.aspectRatio = round6(asp);
  return cam;
}
