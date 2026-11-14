import { z } from 'zod';

/**
 * /projects/{projectId}/auditLog/{entryId}
 *
 * Append-only. Server-side writes only (Cloud Function). Clients never
 * write audit directly — rule: allow write: if false. Per plan v3 §3.7
 * + §10 P0.5.
 */
export const AuditLogSchema = z.object({
  actorUid: z.string(),
  actorEmail: z.string(), // snapshot at time of action
  actorRole: z.string(),
  action: z.string(),
  targetType: z.string(), // 'member' | 'building' | 'folder' | 'invitation' | 'project'
  targetId: z.string(),
  details: z.record(z.unknown()),
  timestamp: z.number().int(),
});

export type AuditLog = z.infer<typeof AuditLogSchema>;

/** Standard audit actions (v4 two-role model — role/readRoles actions dropped). */
export const AuditActions = {
  MEMBER_INVITED: 'member.invited',
  MEMBER_ACCEPTED: 'member.accepted',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_ROLE_CHANGED: 'member.roleChanged',
  BUILDING_CREATED: 'building.created',
  FOLDER_CREATED: 'folder.created',
  PROJECT_CREATED: 'project.created',
  BOOTSTRAP_FIRST_ADMIN: 'bootstrap.firstAdmin',
} as const;