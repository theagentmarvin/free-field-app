import { z } from 'zod';
import { SyncBaseSchema } from './syncBase';

/**
 * /projects/{projectId}/buildings/{buildingId}  (BuildingRecord + sync base)
 *
 * Any active member reads; admins write (firestore.rules). Delete is a
 * tombstone (`deletedAt`), never a hard delete.
 */
export const BuildingSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string().min(1),
    metadata: z.record(z.unknown()),
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);

export type Building = z.infer<typeof BuildingSchema>;
