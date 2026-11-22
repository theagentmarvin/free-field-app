import { z } from 'zod';

/**
 * /projects/{projectId}/tasks/{taskId}
 *
 * Task-module schema (docs/plans/2026-11-01-task-module-plan.md §2.2,
 * deltas D1/D2 from .claude/specs/task-39-tasks-day1-dataplane.md).
 *
 * Convention notes (matching the live repo, not the plan verbatim):
 *   - Epoch millis (`z.number().int()`) stand in for Firestore
 *     `Timestamp` here (tasks are written by the client). Keeps rules
 *     + tests numeric. (Project / member docs written by Cloud
 *     Functions carry real Timestamps — see ./timestamp.ts.)
 *   - `updatedAt` is the list sort key; `status` filters by equality.
 *   - D1: bim elements are `{modelId, expressId}` PAIRS — a bare
 *     express id is ambiguous across federated models.
 *   - D2: cameraPose carries `isOrtho`; projection is part of the
 *     author's viewpoint (ff-viewer-react `ViewerPose` mirrors this
 *     shape one-for-one).
 *
 * The two-role matrix amendment (D7): tasks are the FIRST
 * member-writable collection. Rules enforce legality server-side;
 * the client map in `@ff/tasks/src/status.ts` is the same table.
 */

export const TaskStatusSchema = z.union([
  z.literal(10), // inbox
  z.literal(20), // ongoing
  z.literal(30), // rejected (reserved — reject is transient in v1, lands back in 20)
  z.literal(40), // awaiting_approval
  z.literal(60), // approved_followup
  z.literal(65), // approved (terminal)
  z.literal(80), // discontinued (terminal)
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskActionNameSchema = z.enum([
  'create',
  'comment',
  'assign',
  'complete',
  'reject',
  'approve',
  'followup',
  'discontinue',
  'edit',
]);
export type TaskActionName = z.infer<typeof TaskActionNameSchema>;

/** Photo metadata. BYTES never live in Firestore — Storage only (§2.3). */
export const TaskPhotoSchema = z.object({
  storagePath: z.string().min(1),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  caption: z.string().optional(),
});
export type TaskPhoto = z.infer<typeof TaskPhotoSchema>;

const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const TaskLocationSchema = z.object({
  storeyName: z.string().nullable(),
  /** Day-3 location snapshot: Storage path of the context thumbnail
   *  captured at the tap moment. Bytes live in Storage; the doc only
   *  carries the path (same discipline as photos[].storagePath). */
  thumb: z
    .object({
      storagePath: z.string().min(1),
    })
    .optional(),
  /** LinkView dual location: Storage path of the PLAN snapshot, set only
   *  on tasks created in LinkView (`origin: 'linkview'`), where `thumb`
   *  stays the 3D snapshot and `bim` + `pdf` are both set. Additive and
   *  optional: every other task omits it, and readers that do not know it
   *  ignore it. Lives inside `location`, so no rules change is needed. */
  thumb2d: z
    .object({
      storagePath: z.string().min(1),
    })
    .optional(),
  /** Which surface created the task. Currently only `'linkview'` (the
   *  split module: 2D pin AND 3D placement stored together). Absent =
   *  Models / Documents / Tasks, shown and opened exactly as before.
   *  A plain string so a later origin never fails an older client. */
  origin: z.string().min(1).optional(),
  bim: z
    .object({
      elements: z.array(
        z.object({ modelId: z.string().min(1), expressId: z.number().int() })
      ),
      worldPoint: Vec3.nullable(),
      cameraPose: z
        .object({
          pos: Vec3,
          target: Vec3,
          fov: z.number(),
          isOrtho: z.boolean(),
        })
        .nullable(),
    })
    .nullable(),
  pdf: z
    .object({
      pdfFileId: z.string().min(1),
      page: z.number().int().positive(),
      uv: z.tuple([z.number(), z.number()]),
      /** Calibration used at pin time. Required; plans without a
       *  calibration use the official sentinel `UNCALIBRATED_CALIB_ID`
       *  ("uncalibrated", @ff/types). */
      calibId: z.string().min(1),
      /** w72: the plan VERSION (PdfVersionRecord.id) the pin was placed
       *  on. Optional — pins written before w72 omit it and stay valid;
       *  readers treat absent as "latest at the time" (unknown). */
      pdfVersionId: z.string().min(1).optional(),
    })
    .nullable(),
  text: z.string().optional(),
});
export type TaskLocation = z.infer<typeof TaskLocationSchema>;

/**
 * A project sheet attached to a task BY REFERENCE (never a copy). Additive,
 * optional on the doc; the rules allowlist needs `sheetRefs` before a cloud
 * write succeeds (docs/integration/task-sheet-refs-rules.md).
 */
export const TaskSheetRefSchema = z.object({
  pdfFileId: z.string().min(1),
  pdfVersionId: z.string().min(1),
  /** display snapshot of the version number at attach time */
  versionNumber: z.number().int().positive().optional(),
  /** display snapshot of the sheet file name at attach time */
  name: z.string(),
  page: z.number().int().positive().optional(),
});
export type TaskSheetRef = z.infer<typeof TaskSheetRefSchema>;

export const TaskSchema = z.object({
  id: z.string().min(1),
  num: z.number().int().positive(), // display "T001" (formatTaskNum); immutable after create
  title: z.string().min(1).max(200),
  description: z.string().max(20000).default(''),
  type: z.string().default('task'), // free tag; future template key
  status: TaskStatusSchema,

  createdBy: z.string(),
  createdByUid: z.string(),
  createdAt: z.number().int(),
  updatedBy: z.string(),
  updatedAt: z.number().int(), // sort key
  assigneeUid: z.string().nullable(),
  assigneeName: z.string().nullable(),
  deadline: z.number().int().nullable(),

  /** Tasks UI refresh v1 (docs/ux/tasks-ui-refresh-v1.md §2): the
   *  building this task belongs to. `null` = legacy/cross-building —
   *  renders "—" and appears in BOTH rail-building scopes (never
   *  orphaned). Additive + backfillable: no migration, rules unchanged. */
  buildingId: z.string().nullable().default(null),

  location: TaskLocationSchema.nullable(),
  photos: z.array(TaskPhotoSchema).default([]),
  /** project sheets attached by reference (optional; absent on older tasks) */
  sheetRefs: z.array(TaskSheetRefSchema).max(20).optional(),

  lastAction: TaskActionNameSchema, // denormalized chip
  entryCount: z.number().int().nonnegative().default(0),
});
export type Task = z.infer<typeof TaskSchema>;

/** Doc-id convention for the per-project counter (one doc per project). */
export const TASK_COUNTER_DOC_ID = 'tasks';
