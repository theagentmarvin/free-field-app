/**
 * Auth trigger: reconciliation for the first-admin bootstrap.
 *
 * The client writes a /users/{uid} doc on first sign-in (FinishSignInPage),
 * which fires this trigger. It is now a bootstrap reconciliation hook ONLY:
 *
 *   - The email-of-record is derived from the auth server record
 *     (`auth.getUser(uid)`), never from the client-writable document
 *     (P0-1). A missing or unverified email bails out immediately.
 *
 *   - Invitation redemption no longer runs here. It was moved to the
 *     `redeemInvitation` callable (P0-3 / P1-4): redemption runs on sign-in
 *     against the link-carried `inviteId`, so a doc already existed for the
 *     user cannot block or overwrite a later invitation.
 *
 * The bootstrap path below stays as the reconciling counterpart of
 * `bootstrapFirstAdmin` Mode A (email-link): the deployer clicks the link,
 * signs in, and the profile doc fires this trigger which promotes them.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const PROJECT_ID = 'default-project';

export const onUserCreatedCompleteBootstrap = onDocumentCreated(
  'users/{uid}',
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;

    const uid = event.params.uid;
    const db = getFirestore();
    const auth = getAuth();

    // F1: never trust the client-written email. Derive from the auth record.
    let authUser;
    try {
      authUser = await auth.getUser(uid);
    } catch (err) {
      // User no longer exists (deleted race) — nothing to reconcile.
      return;
    }

    if (!authUser.email || !authUser.emailVerified) {
      // No verified email-of-record → no promotion path.
      return;
    }

    await completeBootstrapIfPending(db, auth, uid, authUser.email);
  }
);

// ── Bootstrap completion (reconciliation only) ─────────────────────

async function completeBootstrapIfPending(
  db: ReturnType<typeof getFirestore>,
  auth: ReturnType<typeof getAuth>,
  uid: string,
  email: string
): Promise<boolean> {
  const metaRef = db.doc('meta/bootstrap');
  const emailLower = email.toLowerCase();

  // Atomic check + claim to prevent races with bootstrapFirstAdmin.
  const shouldBootstrap = await db.runTransaction(async (tx: Transaction) => {
    const meta = await tx.get(metaRef);
    const metaData = meta.data();

    if (!meta.exists || metaData?.status !== 'pending') return false;
    const firstAdminEmail =
      typeof metaData.firstAdminEmail === 'string'
        ? metaData.firstAdminEmail.toLowerCase()
        : '';
    if (firstAdminEmail !== emailLower) return false;

    tx.set(
      metaRef,
      { firstAdminUid: uid, claimedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return true;
  });

  if (!shouldBootstrap) return false;

  await db.doc(`projects/${PROJECT_ID}`).set({
    name: 'Default Project',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
  });

  await db.doc(`projects/${PROJECT_ID}/members/${uid}`).set({
    uid,
    role: 'admin',
    joinedAt: FieldValue.serverTimestamp(),
    invitedBy: 'bootstrap',
    status: 'active',
  });

  await auth.setCustomUserClaims(uid, {
    currentProject: { id: PROJECT_ID, role: 'admin' },
  });

  await metaRef.set(
    { status: 'complete', completedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );

  console.log(`Bootstrap completed via onCreateUser for uid=${uid}, email=${email}`);
  return true;
}