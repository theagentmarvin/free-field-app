import type { Task, TaskEntry, TaskLocation, TaskPhoto, TaskStatus } from '@ff/firestore';

import type { DemoTaskSeed } from './demoTaskSource';
import type { DemoTaskSource } from './demoTaskSource';
import { demoPhotoDataUrl } from './demoPhotos';

/**
 * First-boot demo task seed — 8 realistic tasks wired onto the REAL demo
 * model/storey/pdf ids (read by apps/settings from Dexie after the
 * building/IFC/PDF seed lands). Pure here: the caller passes the resolved
 * context, so the id/idempotency shape is unit-testable without Dexie.
 *
 * Status mix per spec: one awaiting-approval (40), one rejected (30 —
 * the reserved "rejected" display state, valid seed data even though v1
 * verbs never land there from the user side), one terminal (65 approved),
 * plus ongoing/inbox/discontinued and overdue deadlines.
 */

export interface DemoStoreyInfo {
  name: string;
  elevation: number;
  expressId: number;
  containedElementIds: number[];
}

export interface DemoSeedContext {
  projectId: string;
  /** the IfcFileRecord.id — the viewer's `modelId` for bim elements */
  modelId: string;
  storeys: DemoStoreyInfo[];
  /** the PdfFileRecord.id for S-101 */
  pdfFileId: string;
  /** deterministic overrides for tests */
  now?: number;
  newId?: () => string;
  /** calibration id for the 2D seed pin (S-101 ships UNMAPPED, so the
   *  demo fabricates a stable id — the pin still renders from stored uv). */
  calibId?: string;
}

const DAY = 24 * 60 * 60 * 1000;

function newId(fn: (() => string) | undefined): string {
  if (fn) return fn();
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const SHA_PLACEHOLDER = '0'.repeat(64);

function mkPhoto(
  projectId: string,
  taskId: string,
  index: number,
): { meta: TaskPhoto; dataUrl: string; storagePath: string } {
  const storagePath = `projects/${projectId}/tasks/${taskId}/${SHA_PLACEHOLDER.slice(0, 12)}-seed${index}.png`;
  const dataUrl = demoPhotoDataUrl(index);
  return {
    storagePath,
    dataUrl,
    meta: {
      storagePath,
      sha256: SHA_PLACEHOLDER,
      size: dataUrl.length,
      mime: 'image/png',
    },
  };
}

function entry(
  id: string,
  action: TaskEntry['action'],
  text: string,
  by: string,
  byUid: string,
  at: number,
  statusFrom: TaskStatus | null,
  statusTo: TaskStatus,
  photos: TaskPhoto[] = [],
): TaskEntry {
  return {
    id,
    action,
    text,
    by,
    byUid,
    at,
    statusFrom,
    statusTo,
    photos,
    clientGuid: id,
  };
}

interface Spec {
  num: number;
  title: string;
  description: string;
  type: string;
  status: TaskStatus;
  createdBy: string;
  createdByUid: string;
  assigneeName: string | null;
  assigneeUid: string | null;
  deadline: number | null;
  /** UI-refresh v1: demo rows default to cross-building (null). */
  buildingId?: string | null;
  location: TaskLocation | null;
  photos: TaskPhoto[];
  lastAction: TaskEntry['action'];
  entryCount: number;
}

function buildTask(
  spec: Spec,
  id: string,
  createdAt: number,
  updatedAt: number,
): Task {
  return {
    id,
    num: spec.num,
    title: spec.title,
    description: spec.description,
    type: spec.type,
    status: spec.status,
    createdBy: spec.createdBy,
    createdByUid: spec.createdByUid,
    createdAt,
    updatedBy: spec.createdBy,
    updatedAt,
    assigneeUid: spec.assigneeUid,
    assigneeName: spec.assigneeName,
    deadline: spec.deadline,
    buildingId: spec.buildingId ?? null,
    location: spec.location,
    photos: spec.photos,
    lastAction: spec.lastAction,
    entryCount: spec.entryCount,
  };
}

const PEOPLE = {
  alex: { uid: 'demo-admin', name: 'Alex Rivera' },
  ana: { uid: 'ana-silva', name: 'Ana Silva' },
  mateo: { uid: 'mateo-rojas', name: 'Mateo Rojas' },
  sofia: { uid: 'sofia-vargas', name: 'Sofia Vargas' },
} as const;

export function buildDemoTaskSeeds(ctx: DemoSeedContext): DemoTaskSeed[] {
  const now = ctx.now ?? Date.now();
  const storeys = ctx.storeys.length > 0 ? ctx.storeys : [
    { name: 'Level 1', elevation: 0, expressId: 100, containedElementIds: [1001] },
  ];
  const pick = (i: number) => storeys[i] ?? storeys[0];
  const expressIdOf = (s: DemoStoreyInfo) =>
    (s.containedElementIds.length > 0 ? s.containedElementIds[0] : s.expressId);

  const calibId = ctx.calibId ?? 'demo-seed-s101-calib';

  function bimLocation(i: number, x: number, z: number): TaskLocation {
    const s = pick(i);
    const y = s.elevation;
    return {
      storeyName: s.name,
      bim: {
        elements: [{ modelId: ctx.modelId, expressId: expressIdOf(s) }],
        worldPoint: [x, y, z],
        cameraPose: {
          pos: [x + 6, y + 7, z + 6],
          target: [x, y, z],
          fov: 60,
          isOrtho: false,
        },
      },
      pdf: null,
    };
  }

  function pdfLocation(uv: [number, number]): TaskLocation {
    return {
      storeyName: pick(0).name,
      bim: null,
      pdf: { pdfFileId: ctx.pdfFileId, page: 1, uv, calibId },
    };
  }

  const seeds: DemoTaskSeed[] = [];

  // T001 — ongoing, 3D, overdue, 1 photo
  {
    const id = newId(ctx.newId);
    const p = mkPhoto(ctx.projectId, id, 0);
    const at = now - DAY * 2;
    seeds.push({
      task: buildTask(
        {
          num: 1, title: 'Crack in slab at Level 2, column line C-4',
          description: 'Hairline crack visible at the slab edge near column C-4. Photographed for the record.',
          type: 'Defect', status: 20,
          createdBy: PEOPLE.ana.name, createdByUid: PEOPLE.ana.uid,
          assigneeName: PEOPLE.ana.name, assigneeUid: PEOPLE.ana.uid,
          deadline: now - DAY, location: bimLocation(1, 10, 20),
          photos: [p.meta], lastAction: 'assign', entryCount: 2,
        },
        id, at, now - DAY,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Flagging a hairline crack in the slab edge near column C-4.', PEOPLE.ana.name, PEOPLE.ana.uid, at, null, 10, [p.meta]),
        entry(newId(ctx.newId), 'assign', 'Assigned to Ana for a field check + photo set.', PEOPLE.ana.name, PEOPLE.ana.uid, at + 1, 10, 20),
      ],
      photos: [p],
    });
  }

  // T002 — awaiting approval, no location
  {
    const id = newId(ctx.newId);
    const at = now - DAY;
    seeds.push({
      task: buildTask(
        {
          num: 2, title: 'Formwork re-check for east core walls',
          description: 'Re-verify the east core formwork alignment against the updated structural model before the pour.',
          type: 'RFI', status: 40,
          createdBy: PEOPLE.mateo.name, createdByUid: PEOPLE.mateo.uid,
          assigneeName: PEOPLE.mateo.name, assigneeUid: PEOPLE.mateo.uid,
          deadline: now + 6 * 60 * 60 * 1000, location: null,
          photos: [], lastAction: 'complete', entryCount: 3,
        },
        id, at, now - 2 * 60 * 60 * 1000,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Re-check the east core formwork per the coordination note.', PEOPLE.mateo.name, PEOPLE.mateo.uid, at, null, 10),
        entry(newId(ctx.newId), 'assign', 'Assigned to Mateo.', PEOPLE.mateo.name, PEOPLE.mateo.uid, at + 1, 10, 20),
        entry(newId(ctx.newId), 'complete', 'Verified — submitting for approval.', PEOPLE.mateo.name, PEOPLE.mateo.uid, at + 2, 20, 40),
      ],
      photos: [],
    });
  }

  // T003 — rejected (reserved 30), 3D, 2 photos
  {
    const id = newId(ctx.newId);
    const p0 = mkPhoto(ctx.projectId, id, 0);
    const p1 = mkPhoto(ctx.projectId, id, 1);
    const at = now - DAY * 3;
    seeds.push({
      task: buildTask(
        {
          num: 3, title: 'Ceiling clearance clash with duct run',
          description: 'Duct run crosses the corridor ceiling at grid E-7 with insufficient clearance. Needs a reroute.',
          type: 'Defect', status: 30,
          createdBy: PEOPLE.sofia.name, createdByUid: PEOPLE.sofia.uid,
          assigneeName: PEOPLE.sofia.name, assigneeUid: PEOPLE.sofia.uid,
          deadline: null, location: bimLocation(2, -5, 8),
          photos: [p0.meta, p1.meta], lastAction: 'comment', entryCount: 3,
        },
        id, at, at + 2,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Flagging the ceiling clearance clash from the coordination model.', PEOPLE.sofia.name, PEOPLE.sofia.uid, at, null, 10, [p0.meta]),
        entry(newId(ctx.newId), 'assign', 'Assigned to Sofia to inspect both sides of the crossing.', PEOPLE.sofia.name, PEOPLE.sofia.uid, at + 1, 10, 20),
        entry(newId(ctx.newId), 'comment', 'Rejected — revise the duct route per the coordination model and resubmit.', PEOPLE.alex.name, PEOPLE.alex.uid, at + 2, 20, 20, [p1.meta]),
      ],
      photos: [p0, p1],
    });
  }

  // T004 — approved (terminal 65), no location
  {
    const id = newId(ctx.newId);
    const at = now - DAY * 5;
    seeds.push({
      task: buildTask(
        {
          num: 4, title: 'Handrail height fix on Level 1 stair',
          description: 'Top handrail was 40mm under spec on the Level 1 open stair; refixed and re-inspected.',
          type: 'Snag', status: 65,
          createdBy: PEOPLE.ana.name, createdByUid: PEOPLE.ana.uid,
          assigneeName: PEOPLE.ana.name, assigneeUid: PEOPLE.ana.uid,
          deadline: now - DAY * 4, location: null,
          photos: [], lastAction: 'approve', entryCount: 4,
        },
        id, at, now - DAY * 4,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Handrail height under spec on the Level 1 stair.', PEOPLE.ana.name, PEOPLE.ana.uid, at, null, 10),
        entry(newId(ctx.newId), 'assign', 'Assigned to Ana.', PEOPLE.ana.name, PEOPLE.ana.uid, at + 1, 10, 20),
        entry(newId(ctx.newId), 'complete', 'Refixed to spec — submitting for approval.', PEOPLE.ana.name, PEOPLE.ana.uid, at + 2, 20, 40),
        entry(newId(ctx.newId), 'approve', 'Approved after re-inspection.', PEOPLE.alex.name, PEOPLE.alex.uid, at + 3, 40, 65),
      ],
      photos: [],
    });
  }

  // T005 — inbox, unassigned
  {
    const id = newId(ctx.newId);
    const at = now - 2 * 60 * 60 * 1000;
    seeds.push({
      task: buildTask(
        {
          num: 5, title: 'Verify fire-rating on partition wall',
          description: 'Confirm the fire-rating tag matches the spec on the Level 1 partition wall.',
          type: 'Info', status: 10,
          createdBy: PEOPLE.alex.name, createdByUid: PEOPLE.alex.uid,
          assigneeName: null, assigneeUid: null,
          deadline: now + DAY * 4, location: null,
          photos: [], lastAction: 'create', entryCount: 1,
        },
        id, at, at,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Confirm the fire-rating tag on the partition wall matches spec.', PEOPLE.alex.name, PEOPLE.alex.uid, at, null, 10),
      ],
      photos: [],
    });
  }

  // T006 — ongoing, 2D on S-101 page 1, 1 photo
  {
    const id = newId(ctx.newId);
    const p = mkPhoto(ctx.projectId, id, 0);
    const at = now - DAY;
    seeds.push({
      task: buildTask(
        {
          num: 6, title: 'Missing door schedule on S-101',
          description: 'The door schedule referenced on S-101 has no accompanying tag on the plan.',
          type: 'Snag', status: 20,
          createdBy: PEOPLE.mateo.name, createdByUid: PEOPLE.mateo.uid,
          assigneeName: PEOPLE.mateo.name, assigneeUid: PEOPLE.mateo.uid,
          deadline: now + DAY * 2, location: pdfLocation([0.62, 0.42]),
          photos: [p.meta], lastAction: 'assign', entryCount: 2,
        },
        id, at, now - 12 * 60 * 60 * 1000,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Door schedule tag is missing on S-101 near the corridor.', PEOPLE.mateo.name, PEOPLE.mateo.uid, at, null, 10, [p.meta]),
        entry(newId(ctx.newId), 'assign', 'Assigned to Mateo to add the tag.', PEOPLE.mateo.name, PEOPLE.mateo.uid, at + 1, 10, 20),
      ],
      photos: [p],
    });
  }

  // T007 — ongoing, 3D, overdue, no photo
  {
    const id = newId(ctx.newId);
    const at = now - DAY * 4;
    seeds.push({
      task: buildTask(
        {
          num: 7, title: 'Touch-up paint at Level 3 openings',
          description: 'Window openings on Level 3 need a second coat after the scaffold moved.',
          type: 'Defect', status: 20,
          createdBy: PEOPLE.sofia.name, createdByUid: PEOPLE.sofia.uid,
          assigneeName: PEOPLE.sofia.name, assigneeUid: PEOPLE.sofia.uid,
          deadline: now - DAY * 3, location: bimLocation(0, 12, -4),
          photos: [], lastAction: 'assign', entryCount: 2,
        },
        id, at, now - DAY * 3,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Window openings on Level 3 need a second coat.', PEOPLE.sofia.name, PEOPLE.sofia.uid, at, null, 10),
        entry(newId(ctx.newId), 'assign', 'Assigned to Sofia.', PEOPLE.sofia.name, PEOPLE.sofia.uid, at + 1, 10, 20),
      ],
      photos: [],
    });
  }

  // T008 — discontinued (terminal 80), unassigned
  {
    const id = newId(ctx.newId);
    const at = now - DAY * 6;
    seeds.push({
      task: buildTask(
        {
          num: 8, title: 'Temporary scaffold tie-off detail',
          description: 'Scaffold was demobilised; the tie-off detail is no longer required.',
          type: 'Other', status: 80,
          createdBy: PEOPLE.alex.name, createdByUid: PEOPLE.alex.uid,
          assigneeName: null, assigneeUid: null,
          deadline: null, location: null,
          photos: [], lastAction: 'discontinue', entryCount: 2,
        },
        id, at, now - DAY * 5,
      ),
      entries: [
        entry(newId(ctx.newId), 'create', 'Capture the temporary scaffold tie-off detail before demobilisation.', PEOPLE.alex.name, PEOPLE.alex.uid, at, null, 10),
        entry(newId(ctx.newId), 'discontinue', 'Scaffold demobilised — no longer required, closing.', PEOPLE.alex.name, PEOPLE.alex.uid, at + 1, 10, 80),
      ],
      photos: [],
    });
  }

  return seeds;
}

/** Convenience: seed the demo source from a resolved context (idempotent). */
export async function seedDemoTasks(
  source: DemoTaskSource,
  ctx: DemoSeedContext,
): Promise<boolean> {
  return source.seed(ctx.projectId, buildDemoTaskSeeds(ctx));
}