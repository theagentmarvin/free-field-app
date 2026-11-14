/**
 * Shared helpers for the FreeField user-module Cloud Functions.
 *
 * v4 two-role model (plan v4 §1-§3): custom claims have the locked shape
 *
 *   { currentProject: { id: string; role: "admin" | "member" } }
 *
 * and every admin-only callable checks that shape on request.auth.token.
 */

import { HttpsError } from 'firebase-functions/v2/https';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import type { getAuth } from 'firebase-admin/auth';

/** Invitation TTL in days (plan v3 §3.6, kept in v4). */
export const INVITATION_TTL_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function invitationExpiryMs(nowMs: number): number {
  return nowMs + INVITATION_TTL_DAYS * MS_PER_DAY;
}

interface CurrentProjectClaim {
  id?: string;
  role?: string;
}

/**
 * Returns the caller's current project id and enforces the admin role.
 * Throws HttpsError('permission-denied') when the caller is not an admin
 * of a project.
 */
export function requireAdminProject(request: CallableRequest): string {
  const cp = (request.auth?.token?.currentProject ?? null) as
    | CurrentProjectClaim
    | null;

  if (!request.auth || !cp || typeof cp.id !== 'string' || cp.id.length === 0) {
    throw new HttpsError(
      'permission-denied',
      'You must be signed in to a project to perform this action.'
    );
  }
  if (cp.role !== 'admin') {
    throw new HttpsError(
      'permission-denied',
      'Admin privileges are required for this action.'
    );
  }
  return cp.id;
}

/** Count the active admins of a project (single query — last-admin guard). */
export async function countActiveAdmins(
  db: ReturnType<typeof getFirestore>,
  projectId: string
): Promise<number> {
  const snap = await db
    .collection(`projects/${projectId}/members`)
    .where('role', '==', 'admin')
    .get();
  let count = 0;
  for (const doc of snap.docs) {
    if (doc.get('status') !== 'removed') count += 1;
  }
  return count;
}

/** Email for a uid from /users/{uid}, or null when unknown. */
export async function getUserEmail(
  db: ReturnType<typeof getFirestore>,
  uid: string
): Promise<string | null> {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) return null;
  const email = snap.get('email');
  return typeof email === 'string' ? email : null;
}

/**
 * Phase 1b: resolve the project an admin callable acts on and authorize
 * the caller from their MEMBERSHIP DOC (an active admin of that project),
 * never from the token claim alone.
 *
 * The project is `data.projectId` when the client names one (the shell
 * always does, because a user may belong to several projects), else the
 * `currentProject` claim (pre-1b clients). Claims stay a fallback source
 * for the project id only until Phase 1e.
 */
export async function resolveAdminProject(
  request: CallableRequest,
  db: ReturnType<typeof getFirestore>
): Promise<string> {
  if (!request.auth) {
    throw new HttpsError(
      'permission-denied',
      'You must be signed in to a project to perform this action.'
    );
  }
  const data = request.data as { projectId?: unknown } | undefined;
  const explicit =
    typeof data?.projectId === 'string' && data.projectId.length > 0 ? data.projectId : null;
  const cp = (request.auth.token?.currentProject ?? null) as CurrentProjectClaim | null;
  const claimId = cp && typeof cp.id === 'string' && cp.id.length > 0 ? cp.id : null;
  const projectId = explicit ?? claimId;
  if (!projectId) {
    throw new HttpsError(
      'permission-denied',
      'You must be signed in to a project to perform this action.'
    );
  }
  const snap = await db.doc(`projects/${projectId}/members/${request.auth.uid}`).get();
  if (!snap.exists || snap.get('status') !== 'active' || snap.get('role') !== 'admin') {
    throw new HttpsError(
      'permission-denied',
      'Admin privileges are required for this action.'
    );
  }
  return projectId;
}

/**
 * Keep the `currentProject` claim (transitional, removed in 1e) from
 * pointing at the wrong project: it is rewritten (or cleared when `role`
 * is null) ONLY when it currently names `projectId`. A user who belongs to
 * several projects keeps the claim of the project they are working in.
 */
export async function updateClaimForProject(
  auth: ReturnType<typeof getAuth>,
  uid: string,
  projectId: string,
  role: 'admin' | 'member' | null
): Promise<void> {
  const record = await auth.getUser(uid);
  const claims = (record.customClaims ?? {}) as { currentProject?: { id?: string } | null };
  if (claims.currentProject?.id !== projectId) return;
  await auth.setCustomUserClaims(uid, role ? { currentProject: { id: projectId, role } } : null);
}
