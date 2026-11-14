import { z } from 'zod';

import { TaskActionNameSchema, TaskPhotoSchema, TaskStatusSchema } from './task';

/**
 * /projects/{projectId}/tasks/{taskId}/entries/{entryId}
 *
 * Append-only timeline entry (plan §2.3). The doc ID IS the
 * `clientGuid` — idempotency key for retried transactions (rules
 * enforce `entryId == data.clientGuid`). Audit is free because
 * update/delete are denied outright.
 *
 * `statusFrom`/`statusTo` record the state-machine edge this action
 * traversed; `create` is the only entry whose `statusFrom` is null.
 */
export const TaskEntrySchema = z.object({
  id: z.string().min(1), // == clientGuid (uuid v4)
  action: TaskActionNameSchema,
  text: z.string().max(20000).default(''),
  by: z.string(),
  byUid: z.string(),
  at: z.number().int(),
  statusFrom: TaskStatusSchema.nullable(),
  statusTo: TaskStatusSchema.nullable(),
  photos: z.array(TaskPhotoSchema).default([]),
  clientGuid: z.string().min(1),
});
export type TaskEntry = z.infer<typeof TaskEntrySchema>;
