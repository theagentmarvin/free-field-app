import { z } from 'zod';

/** Invitations expire after 7 days (plan v3 §3.6 + §10 P0.4; kept in v4). */
export const INVITATION_TTL_DAYS = 7;

/**
 * /projects/{projectId}/invitations/{inviteId}
 */
export const InvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']),
  invitedBy: z.string(),
  invitedAt: z.number().int(),
  expiresAt: z.number().int(),
  status: z.enum(['pending', 'accepted', 'revoked', 'expired']),
  acceptedBy: z.string().optional(),
  acceptedAt: z.number().int().optional(),
});

export type Invitation = z.infer<typeof InvitationSchema>;

export const INVITATION_STATUS = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
  EXPIRED: 'expired',
} as const;