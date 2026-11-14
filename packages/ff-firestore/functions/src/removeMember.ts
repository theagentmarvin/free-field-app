/**
 * removeMember — callable, admin-only (plan v4 §3).
 *
 * Deletes the members doc inside one transaction (with the last-admin guard
 * re-running on the CURRENT caller membership), then clears the target's
 * custom claims, revokes their refresh token, and revokes their pending
 * invitations.
 *
 * Last-admin guard (P0-2, P1-1, P1-2): re-reads the CALLER's doc, requires
 * an ACTIVE admin, and rejects removing the last admin with
 * `failed-precondition` — for self OR any other target — all inside the
 * same transaction as the delete.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import {
  resolveAdminProject,
  updateClaimForProject,
  getUserEmail,
} from './common';

interface RemoveMemberInput {
  uid: string;
  /** Project to act on (Phase 1b); defaults to the claim's project. */
  projectId?: string;
}

export const removeMember = onCall<RemoveMemberInput | void>(
  { enforceAppCheck: false },
  async (request) => {
    const db = getFirestore();
    const auth = getAuth();

    // Fast pre-check on the token claim (the transaction re-reads below).
    const projectId = await resolveAdminProject(request, db);
    const callerUid = request.auth!.uid;

    const data = request.data as RemoveMemberInput | undefined;
    const uid = typeof data?.uid === 'string' ? data.uid : '';

    if (!uid) {
      throw new HttpsError('invalid-argument', 'uid is required.');
    }

    const memberRef = db.doc(`projects/${projectId}/members/${uid}`);

    await db.runTransaction(async (tx: Transaction) => {
      // (a) Re-read the CALLER's membership — claims alone never suffice.
      const callerDoc = await tx.get(
        db.doc(`projects/${projectId}/members/${callerUid}`)
      );
      if (
        !callerDoc.exists ||
        callerDoc.get('role') !== 'admin' ||
        callerDoc.get('status') === 'removed'
      ) {
        throw new HttpsError(
          'permission-denied',
          'Not an admin of this project.'
        );
      }

      const memberSnap = await tx.get(memberRef);
      if (!memberSnap.exists) {
        throw new HttpsError('not-found', 'Member not found.');
      }
      const targetIsActiveAdmin =
        memberSnap.get('role') === 'admin' &&
        memberSnap.get('status') !== 'removed';

      // (b) Guard ANY admin-reducing mutation (self OR other target).
      if (targetIsActiveAdmin) {
        const adminsSnap = await tx.get(
          db
            .collection(`projects/${projectId}/members`)
            .where('role', '==', 'admin')
        );
        const activeAdminCount = adminsSnap.docs.filter(
          (d) => d.get('status') !== 'removed'
        ).length;
        if (activeAdminCount <= 1) {
          throw new HttpsError(
            'failed-precondition',
            'Cannot remove the last admin of the project.'
          );
        }
      }

      // (c) Delete the member doc inside the transaction.
      tx.delete(memberRef);
    });

    // Revoke pending invitations for this member's email (unchanged behavior).
    const email = await getUserEmail(db, uid);
    if (email) {
      const pendingSnap = await db
        .collection(`projects/${projectId}/invitations`)
        .where('email', '==', email.toLowerCase())
        .where('status', '==', 'pending')
        .get();
      const batch = db.batch();
      pendingSnap.docs.forEach((d) => batch.update(d.ref, { status: 'revoked' }));
      await batch.commit();
    }

    // Clear claims and invalidate existing ID tokens after a successful commit.
    await updateClaimForProject(auth, uid, projectId, null);
    await auth.revokeRefreshTokens(uid);

    return { uid };
  }
);