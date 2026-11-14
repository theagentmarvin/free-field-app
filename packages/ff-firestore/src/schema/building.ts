import { z } from 'zod';

/**
 * /projects/{projectId}/buildings/{buildingId}
 *
 * v4 two-role model (plan v4 §2): no per-building readRoles ACL. Any
 * signed-in member of the project can read; writes are admin-only
 * (enforced in firestore.rules, not in this schema).
 */
export const BuildingSchema = z.object({
  name: z.string().min(1),
  createdBy: z.string(),
  createdAt: z.number().int(),
});

export type Building = z.infer<typeof BuildingSchema>;