import { z } from 'zod';

/**
 * /projects/{projectId}/folders/{folderId}
 *
 * v4 two-role model (plan v4 §2): no per-folder readRoles ACL. Any
 * signed-in member of the project can read; writes are admin-only
 * (enforced in firestore.rules). Tree inheritance from v3 is deferred.
 */
export const FolderSchema = z.object({
  name: z.string().min(1),
  parentId: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.number().int(),
});

export type Folder = z.infer<typeof FolderSchema>;