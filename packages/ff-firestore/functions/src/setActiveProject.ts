/**
 * setActiveProject — callable, any signed-in member (SPEC-PHASE-1 §3).
 *
 * Rules no longer read claims (Phase 1b), but the `currentProject` claim
 * stays until 1e as (a) the project fallback of the admin callables and
 * (b) the key of the profile-read rule. The client calls this after it
 * resolves a current project so the claim follows the selection.
 *
 * Authorization: an ACTIVE member doc for the caller in `projectId`.
 * Returns { projectId, role }; the client then force-refreshes its token.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

interface SetActiveProjectInput {
  projectId: string;
}

export const setActiveProject = onCall<SetActiveProjectInput | void>(
  { enforceAppCheck: false },
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError('unauthenticated', 'You must be signed in.');
    }
    const uid = request.auth.uid;
    const data = request.data as SetActiveProjectInput | undefined;
    const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
    if (!projectId) {
      throw new HttpsError('invalid-argument', 'projectId is required.');
    }

    const snap = await getFirestore().doc(`projects/${projectId}/members/${uid}`).get();
    if (!snap.exists || snap.get('status') !== 'active') {
      throw new HttpsError('permission-denied', 'Not a member of this project.');
    }
    const role: 'admin' | 'member' = snap.get('role') === 'admin' ? 'admin' : 'member';

    await getAuth().setCustomUserClaims(uid, { currentProject: { id: projectId, role } });
    return { projectId, role };
  }
);
