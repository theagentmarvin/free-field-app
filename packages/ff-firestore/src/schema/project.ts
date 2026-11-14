import { z } from 'zod';

import { FirestoreTimeSchema } from './timestamp';

/**
 * /projects/{projectId}
 *
 * Matches what the backend writes (functions/src/bootstrapFirstAdmin.ts
 * and onCreateUser.ts): `{ name, createdAt: serverTimestamp(), createdBy: uid }`.
 * `createdAt` is a Firestore Timestamp there; epoch millis are still
 * accepted for documents written by older code.
 */
export const ProjectSchema = z.object({
  name: z.string().min(1),
  createdAt: FirestoreTimeSchema,
  /** uid of the user whose bootstrap / action created the project. */
  createdBy: z.string().min(1),
});

export type Project = z.infer<typeof ProjectSchema>;
