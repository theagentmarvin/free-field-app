import { z } from 'zod';

import { FirestoreTimeSchema } from './timestamp';

/**
 * /projects/{projectId}/members/{uid}
 *
 * v4 two-role model (plan v4 §0): exactly two roles per project.
 * `removeMember` hard-deletes the doc (admin SDK); no soft-delete
 * tombstones remain in the v4 flow.
 *
 * `uid` (Phase 1b): the doc id repeated as a field so the client can
 * discover its memberships with a collection-group query
 * (`where('uid', '==', me)`, SPEC-PHASE-1 §2.1). Optional in the schema
 * only because docs written before 1b lack it until the one-off backfill
 * (scripts/backfill-member-uids.ts) has run; every writer sets it now.
 *
 * `joinedAt`: every Phase 1b writer stores a server Timestamp. Epoch
 * millis (redeemInvitation before 1b) remain readable until backfilled.
 * `invitedBy` is the inviter's uid, or the literal 'bootstrap' for the
 * first admin.
 */
export const MemberSchema = z.object({
  uid: z.string().min(1).optional(),
  role: z.enum(['admin', 'member']),
  joinedAt: FirestoreTimeSchema,
  invitedBy: z.string(),
  status: z.enum(['active', 'removed', 'pending-acceptance']),
  deletedAt: FirestoreTimeSchema.optional(),
});

export type Member = z.infer<typeof MemberSchema>;

export const MEMBER_STATUS = {
  ACTIVE: 'active',
  REMOVED: 'removed',
  PENDING_ACCEPTANCE: 'pending-acceptance',
} as const;