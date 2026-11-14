/**
 * redeemInvitation — callable, signed-in users only (plan v4 §3, task 29).
 *
 * Redemption now runs on sign-in (FinishSignInPage) against the link-carried
 * `inviteId` instead of a client-created /users doc (P0-3, P1-4).
 *
 * Grant path is exactly one condition: the invitation's email must equal the
 * CALLER's verified email-of-record from `auth.getUser(callerUid)` (lowercased).
 * Nothing else — no client data — is trusted. Within a transaction we:
 *
 *   - require `status === 'pending'` and `expiresAt > now` (number, ms),
 *   - mark the invitation `accepted`,
 *   - create the members doc ONLY IF none exists (never overwrites — P1-3).
 *     It carries `uid` (membership discovery, SPEC-PHASE-1 §2.1) and a
 *     server-Timestamp `joinedAt`,
 *   - set claims `{ currentProject: { id, role } }` after commit (the
 *     redeemed project becomes the claim's project; fallback until 1e).
 *
 * Any non-grant (unknown inviteId, forged email, already accepted, expired,
 * existing membership) returns a benign `'nothing-to-redeem'` result — the
 * caller is permitted to call, but nothing is granted.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue, getFirestore, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

interface RedeemInvitationInput {
  inviteId: string;
}

type RedeemResult =
  | { status: 'accepted'; projectId: string; role: 'admin' | 'member' }
  | { status: 'nothing-to-redeem' };

export const redeemInvitation = onCall<RedeemInvitationInput | void>(
  { enforceAppCheck: false },
  async (request): Promise<RedeemResult> => {
    const db = getFirestore();
    const auth = getAuth();

    if (!request.auth?.uid) {
      throw new HttpsError(
        'unauthenticated',
        'You must be signed in to redeem an invitation.'
      );
    }
    const callerUid = request.auth.uid;

    const data = request.data as RedeemInvitationInput | undefined;
    const inviteId = typeof data?.inviteId === 'string' ? data.inviteId : '';
    if (!inviteId) {
      throw new HttpsError('invalid-argument', 'inviteId is required.');
    }

    // Email-of-record from the auth server record — the ONLY grant source.
    const authUser = await auth.getUser(callerUid);
    if (!authUser.email) {
      // No verified email-of-record → nothing to grant.
      return { status: 'nothing-to-redeem' };
    }
    if (authUser.emailVerified !== true) {
      // Unverified email-of-record is not a grant key (task-30 NEW-2).
      return { status: 'nothing-to-redeem' };
    }
    const callerEmail = authUser.email.toLowerCase();

    // Locate the invitation scoped to the caller's email (the sole grant key).
    // Filter to pending so an already-accepted invitation benignly resolves to
    // nothing-to-redeem through the find-by-id below.
    const invSnap = await db
      .collectionGroup('invitations')
      .where('email', '==', callerEmail)
      .where('status', '==', 'pending')
      .get();

    let projectId: string | undefined;
    for (const d of invSnap.docs) {
      if (d.id === inviteId) {
        projectId = d.ref.parent.parent?.id;
        break;
      }
    }
    if (!projectId) {
      return { status: 'nothing-to-redeem' };
    }

    const invitationRef = db.doc(
      `projects/${projectId}/invitations/${inviteId}`
    );
    const memberRef = db.doc(`projects/${projectId}/members/${callerUid}`);

    const role = await db.runTransaction(async (tx: Transaction) => {
      const invDoc = await tx.get(invitationRef);
      if (!invDoc.exists) return 'nothing-to-redeem' as const;

      const invEmail = String(invDoc.get('email') ?? '').toLowerCase();
      if (invEmail !== callerEmail) return 'nothing-to-redeem' as const;

      const status = invDoc.get('status');
      if (status === 'accepted') return 'nothing-to-redeem' as const;

      const expiresAt = invDoc.get('expiresAt');
      if (
        status !== 'pending' ||
        typeof expiresAt !== 'number' ||
        expiresAt <= Date.now()
      ) {
        return 'nothing-to-redeem' as const;
      }

      // Defense-in-depth (NEW-R3-1): an invitation only outlives its inviter
      // if the inviter is still an active participant. `inviteMember` records
      // `invitedBy` = the inviting admin's uid; a removed admin's residual
      // ≤1h ID token can no longer mint invitations client-side (rules deny
      // invitation writes), but even a client-crafted invitation doc whose
      // `invitedBy` no longer resolves to an active member is revoked here
      // rather than granted. Deliberately stricter than convenience: an
      // invitation from a since-REMOVED admin requires re-invitation by a
      // current admin. A merely-demoted-but-still-active inviter is fine —
      // the invitation was legitimately created while they were admin.
      const invitedByRaw = invDoc.get('invitedBy');
      const invitedBy =
        typeof invitedByRaw === 'string' && invitedByRaw ? invitedByRaw : '';
      if (!invitedBy) {
        // No inviter recorded — an orphaned invitation. Revoke, never grant.
        tx.set(
          invitationRef,
          { status: 'revoked', revokedReason: 'orphaned-inviter', revokedAt: Date.now() },
          { merge: true }
        );
        return 'nothing-to-redeem' as const;
      }
      const inviterRef = db.doc(`projects/${projectId}/members/${invitedBy}`);
      const inviterDoc = await tx.get(inviterRef);
      if (!inviterDoc.exists || inviterDoc.get('status') === 'removed') {
        // The inviter was removed (or never existed) — the ghost-admin case
        // from the review. Revoke the invitation so it can't be redeemed later.
        tx.set(
          invitationRef,
          { status: 'revoked', revokedReason: 'orphaned-inviter', revokedAt: Date.now() },
          { merge: true }
        );
        return 'nothing-to-redeem' as const;
      }

      // Never overwrite an existing membership (P1-3). Reached only when the
      // inviter is still an active participant.
      const memberDoc = await tx.get(memberRef);
      if (memberDoc.exists) {
        // Close the invitation so it can't be redeemed again.
        tx.set(
          invitationRef,
          { status: 'accepted', acceptedBy: callerUid, acceptedAt: Date.now() },
          { merge: true }
        );
        return 'nothing-to-redeem' as const;
      }

      const role = invDoc.get('role') === 'admin' ? 'admin' : 'member';

      tx.set(memberRef, {
        uid: callerUid,
        role,
        joinedAt: FieldValue.serverTimestamp(),
        invitedBy,
        status: 'active',
      });
      tx.set(
        invitationRef,
        { status: 'accepted', acceptedBy: callerUid, acceptedAt: Date.now() },
        { merge: true }
      );

      return role as 'admin' | 'member';
    });

    if (role === 'nothing-to-redeem') {
      return { status: 'nothing-to-redeem' };
    }

    await auth.setCustomUserClaims(callerUid, {
      currentProject: { id: projectId, role },
    });

    return { status: 'accepted', projectId, role };
  }
);