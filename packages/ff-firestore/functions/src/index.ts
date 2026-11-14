/**
 * Cloud Functions for FreeField user module.
 *
 * Two-role production auth (plan v4 §3):
 *   - bootstrapFirstAdmin: callable function (email-link + caller modes)
 *   - onUserCreatedCompleteBootstrap: Firestore trigger that auto-completes
 *     the first-admin bootstrap on first sign-in (reconciliation only).
 *   - inviteMember: admin-only callable → pending invitation + email link
 *     carrying the invitation id.
 *   - redeemInvitation: signed-in callable → redeems the link-carried
 *     invitation by verified email (P0-3 / P1-4).
 *   - setMemberRole: admin-only callable → toggle admin↔member + claims.
 *   - removeMember: admin-only callable → delete member + clear claims +
 *     revoke their pending invitations.
 *
 * All three admin actions guard against removing/demoting the project's
 * last admin (plan v4 §0).
 */

import { initializeApp } from 'firebase-admin/app';

// Ensure firebase-admin is initialized (required in emulator;
// auto-initialized in production Cloud Functions).
initializeApp();

export { bootstrapFirstAdmin } from './bootstrapFirstAdmin';
export { onUserCreatedCompleteBootstrap } from './onCreateUser';
export { inviteMember } from './inviteMember';
export { redeemInvitation } from './redeemInvitation';
export { setMemberRole } from './setMemberRole';
export { removeMember } from './removeMember';
// Phase 1b (SPEC-PHASE-1): N memberships.
export { createProject } from './createProject';
export { setActiveProject } from './setActiveProject';
