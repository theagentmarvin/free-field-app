/**
 * inviteMember — callable, admin-only (plan v4 §3).
 *
 * Body: { email, role } → creates/updates a pending invitation doc (7-day
 * expiry) and returns the email-link URL built with
 * `auth.generateSignInWithEmailLink`. There is no SMTP in v4 — the admin
 * sends the link manually.
 *
 * Rejects inviting an existing (active) member.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { resolveAdminProject, invitationExpiryMs } from './common';

interface InviteMemberInput {
  email: string;
  role: 'admin' | 'member';
  /** Project to act on (Phase 1b); defaults to the claim's project. */
  projectId?: string;
}

export const inviteMember = onCall<InviteMemberInput | void>(
  { enforceAppCheck: false },
  async (request) => {
    const db = getFirestore();
    const auth = getAuth();

    const projectId = await resolveAdminProject(request, db);
    const callerUid = request.auth!.uid;

    const data = request.data as InviteMemberInput | undefined;
    const email =
      typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
    const role = data?.role;

    if (!email || !email.includes('@')) {
      throw new HttpsError('invalid-argument', 'A valid email address is required.');
    }
    if (role !== 'admin' && role !== 'member') {
      throw new HttpsError('invalid-argument', 'role must be "admin" or "member".');
    }

    // P1-2: authorize on CURRENT membership, not the token claim snapshot.
    const callerMemberSnap = await db
      .doc(`projects/${projectId}/members/${callerUid}`)
      .get();
    if (
      !callerMemberSnap.exists ||
      callerMemberSnap.get('role') !== 'admin' ||
      callerMemberSnap.get('status') === 'removed'
    ) {
      throw new HttpsError(
        'permission-denied',
        'Not an admin of this project.'
      );
    }

    // Reject inviting someone who is already an (active) member.
    // Member docs are keyed by uid and carry no email, so resolve the
    // email → uid via the users collection first.
    const usersSnap = await db
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (!usersSnap.empty) {
      const existingUid = usersSnap.docs[0].id;
      const memberSnap = await db
        .doc(`projects/${projectId}/members/${existingUid}`)
        .get();
      if (memberSnap.exists && memberSnap.get('status') !== 'removed') {
        throw new HttpsError(
          'already-exists',
          `${email} is already a member of this project.`
        );
      }
    }

    const now = Date.now();
    const expiresAt = invitationExpiryMs(now);

    // Create/update: refresh an existing pending invitation for this email,
    // otherwise create a new doc (admin SDK — clients cannot write these).
    const pendingSnap = await db
      .collection(`projects/${projectId}/invitations`)
      .where('email', '==', email)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    let invitationId: string;
    if (!pendingSnap.empty) {
      const invitationRef = pendingSnap.docs[0].ref;
      invitationId = invitationRef.id;
      await invitationRef.set(
        { role, invitedBy: callerUid, invitedAt: now, expiresAt, status: 'pending' },
        { merge: true }
      );
    } else {
      const added = await db.collection(`projects/${projectId}/invitations`).add({
        email,
        role,
        invitedBy: callerUid,
        invitedAt: now,
        expiresAt,
        status: 'pending',
      });
      invitationId = added.id;
    }

    const continueUrl = (process.env.APP_ORIGIN ?? 'http://localhost:5173').replace(
      /\/$/,
      ''
    );
    const link = await auth.generateSignInWithEmailLink(email, {
      url: `${continueUrl}/finish-sign-in?inviteId=${invitationId}`,
    });

    return { invitationId, email, role, link, expiresAt };
  }
);