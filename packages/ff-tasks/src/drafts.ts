import { z } from "zod";

/**
 * Half-composed task (plan §7 screen 2, task-39). The compose sheet
 * snapshots this shape into Dexie `drafts` every 15 s while dirty;
 * crash recovery rehydrates it. `id` == the client uuid that will
 * become the taskId when the compose is finally sent.
 */

export const TaskDraftFieldsSchema = z.object({
  title: z.string(),
  description: z.string().default(""),
  type: z.string().default("task"),
  assigneeUid: z.string().nullable().default(null),
  assigneeName: z.string().nullable().default(null),
  deadline: z.number().int().nullable().default(null),
  /** Tasks UI-refresh v1: chosen building (null/absent = cross-building).
   *  Optional so pre-refresh drafts parse unchanged. */
  buildingId: z.string().nullable().optional(),
  location: z
    .object({
      storeyName: z.string().nullable().default(null),
      bim: z
        .object({
          elements: z.array(
            z.object({ modelId: z.string(), expressId: z.number().int() })
          ),
          worldPoint: z
            .tuple([z.number(), z.number(), z.number()])
            .nullable()
            .default(null),
          cameraPose: z
            .object({
              pos: z.tuple([z.number(), z.number(), z.number()]),
              target: z.tuple([z.number(), z.number(), z.number()]),
              fov: z.number(),
              isOrtho: z.boolean(),
            })
            .nullable()
            .default(null),
        })
        .nullable()
        .default(null),
      pdf: z
        .object({
          pdfFileId: z.string(),
          page: z.number().int().positive(),
          uv: z.tuple([z.number(), z.number()]),
          calibId: z.string(),
        })
        .nullable()
        .default(null),
      text: z.string().optional(),
    })
    .nullable()
    .default(null),
  /** Day-3 location snapshot thumb blob ref (blob is in-memory only). */
  locationThumb: z
    .object({
      blobKey: z.string(),
      size: z.number().int(),
      mime: z.string(),
    })
    .nullable()
    .default(null),
  /** composed photo metadata (sha256/path decided at attach time) */
  photoPaths: z
    .array(
      z.object({
        blobKey: z.string(),
        storagePath: z.string(),
        sha256: z.string(),
        size: z.number().int(),
        mime: z.string(),
      })
    )
    .default([]),
});
export type TaskDraftFields = z.infer<typeof TaskDraftFieldsSchema>;

/** Minimal table port so ff-tasks stays decoupled from @ff/data. */
export interface DraftTable {
  get(id: string): Promise<{ id: string; draft: Record<string, unknown> } | undefined>;
  put(row: {
    id: string;
    projectId: string;
    updatedAt: number;
    draft: Record<string, unknown>;
  }): Promise<void>;
  delete(id: string): Promise<void>;
  whereProject(projectId: string): Promise<Array<{ id: string; updatedAt: number; draft: Record<string, unknown> }>>;
}

export async function saveDraft(
  table: DraftTable,
  id: string,
  projectId: string,
  fields: TaskDraftFields,
  now = Date.now()
): Promise<void> {
  await table.put({ id, projectId, updatedAt: now, draft: fields as unknown as Record<string, unknown> });
}

export async function loadDraft(
  table: DraftTable,
  id: string
): Promise<TaskDraftFields | undefined> {
  const row = await table.get(id);
  if (!row) return undefined;
  return TaskDraftFieldsSchema.parse(row.draft);
}

export async function clearDraft(table: DraftTable, id: string): Promise<void> {
  await table.delete(id);
}

/** Newest draft for the project (recovery prompt, Day-3 UI). */
export async function latestDraft(
  table: DraftTable,
  projectId: string
): Promise<{ id: string; fields: TaskDraftFields } | undefined> {
  const rows = await table.whereProject(projectId);
  if (rows.length === 0) return undefined;
  const newest = rows.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  return { id: newest.id, fields: TaskDraftFieldsSchema.parse(newest.draft) };
}
