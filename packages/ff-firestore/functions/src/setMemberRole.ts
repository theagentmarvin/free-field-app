/**
 * setMemberRole — callable, admin-only (plan v4 §3).
 *
 * Toggles `admin` ↔ `member` on a members doc and re-sets that user's
 * custom claims.
 *
 * Last-admin guard (P0-2, P1-1, P1-2): the whole mutation runs in one
 * transaction that (a) re-reads the CALLER's members doc and requires an
 * ACTIVE admin (claims alone never suffice), and (b) recomputes the active
 * admin count inside that same transaction — guarding ANY mutation that
 * reduces the admin set (self OR another target), rejecting the last-admin
 * removal with `failed-precondition`. Custom claims are set and refresh
 * tokens revoked AFTER a successful commit.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { resolveAdminProject, updateClaimForProject } from './common';

interface SetMemberRoleInput {
  uid: string;
  role: 'admin' | 'member';
  /** Project to act on (Phase 1b); defaults to the claim's project. */
  projectId?: string;
}

export const setMemberRole = onCall<SetMemberRoleInput | void>(
  { enforceAppCheck: false },
  async (request) => {
    const db = getFirestore();
    const auth = getAuth();

    // Fast pre-check on the token claim (the transaction re-reads below).
    const projectId = await resolveAdminProject(request, db);
    const callerUid = request.auth!.uid;

    const data = request.data as SetMemberRoleInput | undefined;
    const uid = typeof data?.uid === 'string' ? data.uid : '';
    const role = data?.role;

    if (!uid) {
      throw new HttpsError('invalid-argument', 'uid is required.');
    }
    if (role !== 'admin' && role !== 'member') {
      throw new HttpsError('invalid-argument', 'role must be "admin" or "member".');
    }

    const memberRef = db.doc(`projects/${projectId}/members/${uid}`);
    let targetWasActiveAdmin = false;

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
      targetWasActiveAdmin = targetIsActiveAdmin;
      const reducesAdmin = role !== 'admin';

      // (b) Guard ANY admin-reducing mutation (self OR other target).
      if (targetIsActiveAdmin && reducesAdmin) {
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

      // (c) Write the member doc.
      // `uid` self-heals docs written before Phase 1b (SPEC-PHASE-1 §2.1).
      tx.set(memberRef, { role, uid }, { merge: true });
    });

    // Set claims after commit (the transaction is the authority for role).
    // Claims are set FIRST so a fresh sign-in in this window cannot mint a
    // new token carrying the old admin claim (new-token boundary).
    // Phase 1b: only when the target's claim names THIS project (a user in
    // several projects keeps the claim of the one they are working in).
    await updateClaimForProject(auth, uid, projectId, role);

    // Then revoke refresh tokens after a successful demotion of an active
    // admin. Revocation bounds how long NEW tokens can be minted; it does not
    // bound the ≤1 h lifetime of already-issued ID tokens.
    if (targetWasActiveAdmin && role !== 'admin') {
      await auth.revokeRefreshTokens(uid);
    }

    return { uid, role };
  }
);