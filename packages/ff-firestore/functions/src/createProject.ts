/**
 * createProject — callable, existing admins only (SPEC-PHASE-1 Q2).
 *
 * Body: { name } → creates `/projects/{generatedId}` and the caller's
 * admin member doc in ONE batch (atomic: no project without its first
 * admin, no orphan member doc). Returns { projectId }. The id is a Firestore
 * auto-id; the client then switches to it (`setActiveProject` aligns the
 * transitional claim).
 *
 * Authorization: the caller must be an ACTIVE admin of at least one
 * project (collection-group query on `members`, `uid` + `status`; the
 * role is filtered here so the query needs only the 1b `members(uid,
 * status)` index). Claims are not consulted.
 *
 * `joinedAt` / `createdAt` are server Timestamps (Phase 1b normalization).
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

export const PROJECT_NAME_MAX = 80;

interface CreateProjectInput {
  name: string;
}

export const createProject = onCall<CreateProjectInput | void>(
  { enforceAppCheck: false },
  async (request) => {
    const db = getFirestore();
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in to create a project.');
    }
    const uid = request.auth.uid;

    const data = request.data as CreateProjectInput | undefined;
    const name = typeof data?.name === 'string' ? data.name.trim() : '';
    if (!name || name.length > PROJECT_NAME_MAX) {
      throw new HttpsError(
        'invalid-argument',
        `A project name of 1-${PROJECT_NAME_MAX} characters is required.`
      );
    }

    const mine = await db
      .collectionGroup('members')
      .where('uid', '==', uid)
      .where('status', '==', 'active')
      .get();
    if (!mine.docs.some((d) => d.get('role') === 'admin')) {
      throw new HttpsError('permission-denied', 'Only project admins can create projects.');
    }

    const projectRef = db.collection('projects').doc();
    const batch = db.batch();
    batch.set(projectRef, {
      name,
      createdAt: FieldValue.serverTimestamp(),
      createdBy: uid,
    });
    batch.set(projectRef.collection('members').doc(uid), {
      uid,
      role: 'admin',
      joinedAt: FieldValue.serverTimestamp(),
      invitedBy: uid,
      status: 'active',
    });
    await batch.commit();

    return { projectId: projectRef.id, name };
  }
);
