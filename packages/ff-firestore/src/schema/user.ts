import { z } from 'zod';

/** /users/{userId} — public profile, mirrored from Firebase Auth. */
export const UserSchema = z.object({
  uid: z.string(),
  email: z.string().email(),
  displayName: z.string().optional(),
  createdAt: z.number().int(), // unix ms
  lastSignInAt: z.number().int().optional(),
});

export type User = z.infer<typeof UserSchema>;