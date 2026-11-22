import { z } from 'zod';
import { SyncBaseSchema } from './syncBase';

/**
 * /projects/{projectId}/folders/{folderId}  (PdfFolderRecord + sync base)
 *
 * Project-scoped, nestable PDF folders (`parentId` null = root).
 */
export const FolderSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentId: z.string().min(1).nullable(),
    name: z.string().min(1),
    color: z.string(),
    createdAt: z.number().int(),
  })
  .merge(SyncBaseSchema);

export type Folder = z.infer<typeof FolderSchema>;
