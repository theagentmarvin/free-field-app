/**
 * Bootstrap the first admin of a FreeField Firebase deployment.
 *
 * Per plan v3 §5.3 + §10 P0.7: this function can only run ONCE per
 * Firebase project. The /meta/bootstrap document uses a three-state
 * `status` field to prevent concurrent hijacking:
 *
 *   - absent / 'none': bootstrap never attempted
 *   - 'pending': email-link generated but user hasn't signed in yet
 *   - 'complete': bootstrap finished, locked forever
 *
 * Two invocation modes:
 *
 * A. Email-link mode (CLI/script only):
 *    Requires a pre-shared BOOTSTRAP_SECRET (Firebase Functions secret).
 *    Called with { email, continueUrl, bootstrapSecret }.
 *    Generates a one-time sign-in link. The user clicks the link →
 *    Firebase Auth creates the user → the onCreateUser trigger
 *    detects status='pending' and auto-promotes.
 *
 * B. Caller mode (already signed-in user):
 *    Called from an authenticated context, optionally with
 *    { bootstrapSecret }. Wave 63 gate: the caller's token email must be
 *    VERIFIED and the caller must either present BOOTSTRAP_SECRET or have
 *    that email on the BOOTSTRAP_ADMIN_EMAILS allowlist — otherwise the
 *    first person to sign in to a fresh deployment would become admin.
 *    Uses a Firestore transaction to atomically claim the bootstrap
 *    slot, then creates the project, membership, and custom claims.
 *    Rejects if bootstrap is already 'pending' for a different email.
 *
 * Secrets / params (see docs/integration/w63-security-deploy.md):
 *   - BOOTSTRAP_SECRET (Secret Manager, bound via `secrets:`)
 *   - BOOTSTRAP_ADMIN_EMAILS (string param, comma-separated; may be empty)
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret, defineString } from 'firebase-functions/params';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

import { decideCallerMode, secretsMatch } from './bootstrapGate';

// Bound to the function via `secrets:` below, so the runtime actually
// receives it (reading process.env without binding never sees the value).
const BOOTSTRAP_SECRET = defineSecret('BOOTSTRAP_SECRET');
// Comma-separated verified emails allowed to claim caller mode without the
// secret. Empty by default → caller mode needs the secret.
const BOOTSTRAP_ADMIN_EMAILS = defineString('BOOTSTRAP_ADMIN_EMAILS', { default: '' });

function readSecret(): string {
  try {
    return BOOTSTRAP_SECRET.value() || '';
  } catch {
    return '';
  }
}

interface BootstrapEmailInput {
  email: string;
  continueUrl: string;
  bootstrapSecret: string;
}

interface BootstrapCallerInput {
  bootstrapSecret?: string;
}

type BootstrapStatus = 'none' | 'pending' | 'complete';

interface BootstrapMeta {
  status: BootstrapStatus;
  firstAdminEmail: string;
  firstAdminUid?: string;
  initiatedAt: FirebaseFirestore.Timestamp;
  claimedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
}

const PROJECT_ID = 'default-project';

export const bootstrapFirstAdmin = onCall<BootstrapEmailInput | BootstrapCallerInput | void>(
  { enforceAppCheck: false, secrets: [BOOTSTRAP_SECRET] },
  async (request) => {
    const db = getFirestore();
    const auth = getAuth();
    const metaRef = db.doc('meta/bootstrap');

    const data = (request.data ?? undefined) as
      | (BootstrapEmailInput & BootstrapCallerInput)
      | undefined;

    // --- Mode A: Email-link (CLI/script, requires bootstrap secret) ---
    if (data?.email && data?.continueUrl) {
      return handleEmailLinkMode(data, metaRef, auth, db);
    }

    // --- Mode B: Caller (already signed-in user) ---
    if (!request.auth?.uid) {
      throw new HttpsError(
        'unauthenticated',
        'You must be signed in to bootstrap. Use the email-link mode ' +
          'from the CLI if this is a new deployment.'
      );
    }

    const decision = decideCallerMode({
      email: request.auth.token.email,
      emailVerified: request.auth.token.email_verified,
      providedSecret: data?.bootstrapSecret,
      expectedSecret: readSecret(),
      allowlistRaw: BOOTSTRAP_ADMIN_EMAILS.value(),
    });
    if (!decision.ok) {
      throw new HttpsError(
        'permission-denied',
        decision.reason === 'email-not-verified' || decision.reason === 'no-email'
          ? 'Bootstrap requires a verified email address.'
          : 'This account is not allowed to bootstrap. Pass the bootstrap ' +
              'secret or ask the deployer to add your email to BOOTSTRAP_ADMIN_EMAILS.'
      );
    }

    return handleCallerMode(request.auth.uid, decision.emailLower, metaRef, auth, db);
  }
);

// ── Mode A: Email-link ─────────────────────────────────────────────

async function handleEmailLinkMode(
  data: BootstrapEmailInput,
  metaRef: FirebaseFirestore.DocumentReference,
  auth: ReturnType<typeof getAuth>,
  _db: FirebaseFirestore.Firestore
) {
  const { email, continueUrl, bootstrapSecret } = data;

  // P2-4: normalize the bootstrap email to lowercase so the pending compare
  // in onCreateUser is case-insensitive on both sides.
  const emailLower = email.trim().toLowerCase();

  // C1 fix: Mode A requires a pre-shared bootstrap secret.
  // Without this, any HTTP client could generate sign-in links for
  // arbitrary emails, turning the deployer's Firebase project into a
  // phishing relay.
  const expected = readSecret();
  if (!expected) {
    throw new HttpsError(
      'failed-precondition',
      'Bootstrap secret not configured on the server. ' +
        'Run: firebase functions:secrets:set BOOTSTRAP_SECRET'
    );
  }
  if (!secretsMatch(bootstrapSecret, expected)) {
    throw new HttpsError(
      'permission-denied',
      'Invalid bootstrap secret. Email-link mode requires a secret ' +
        'set by the deployer.'
    );
  }

  if (!emailLower.includes('@')) {
    throw new HttpsError('invalid-argument', 'Invalid email address');
  }

  // Validate continueUrl origin against an allowlist.
  const allowedOrigin = process.env.APP_ORIGIN;
  if (allowedOrigin) {
    try {
      const parsed = new URL(continueUrl);
      if (parsed.origin !== allowedOrigin) {
        throw new HttpsError(
          'invalid-argument',
          `continueUrl origin ${parsed.origin} is not in the allowlist.`
        );
      }
    } catch {
      throw new HttpsError('invalid-argument', 'continueUrl is not a valid URL.');
    }
  }

  // C2 fix: check current status and prevent overwriting a pending bootstrap
  // for a different email.
  const meta = await metaRef.get();
  const metaData = meta.data() as BootstrapMeta | undefined;
  if (metaData?.status === 'complete') {
    throw new HttpsError(
      'failed-precondition',
      'Bootstrap already completed for this Firebase project.'
    );
  }
  if (metaData?.status === 'pending') {
    throw new HttpsError(
      'failed-precondition',
      `Bootstrap is already pending for ${metaData.firstAdminEmail}. ` +
        'Wait for that user to complete sign-in, or reset the bootstrap manually.'
    );
  }

  const link = await auth.generateSignInWithEmailLink(emailLower, {
    url: continueUrl,
  });

  // Mark bootstrap as pending — onCreateUser trigger completes it.
  await metaRef.set({
    status: 'pending' as BootstrapStatus,
    firstAdminEmail: emailLower,
    initiatedAt: FieldValue.serverTimestamp(),
  });

  return { link, email, mode: 'email-link' as const };
}

// ── Mode B: Caller ──────────────────────────────────────────────────

async function handleCallerMode(
  uid: string,
  email: string,
  metaRef: FirebaseFirestore.DocumentReference,
  auth: ReturnType<typeof getAuth>,
  db: FirebaseFirestore.Firestore
) {
  // P2-4: normalize the caller email to lowercase for a case-insensitive
  // pending compare and storage.
  const emailLower = email.trim().toLowerCase();

  // C3 fix: atomic claim via transaction.
  // Two concurrent callers both reading meta before writing would both
  // see "available" and both become admin. The transaction ensures only
  // one wins the claim; the second gets rejected.
  await db.runTransaction(async (tx: Transaction) => {
    const meta = await tx.get(metaRef);
    const metaData = meta.data() as BootstrapMeta | undefined;

    if (metaData?.status === 'complete') {
      throw new HttpsError(
        'failed-precondition',
        'Bootstrap already completed for this Firebase project.'
      );
    }

    // C2 fix: if bootstrap is pending for a different email, reject.
    // This prevents an attacker from hijacking a pending email-link
    // bootstrap by calling Mode B while the deployer is waiting.
    const pendingEmail =
      typeof metaData?.firstAdminEmail === 'string'
        ? metaData.firstAdminEmail.toLowerCase()
        : '';
    if (metaData?.status === 'pending' && pendingEmail !== emailLower) {
      throw new HttpsError(
        'failed-precondition',
        `Bootstrap is pending for ${metaData.firstAdminEmail}. ` +
          'Only that user can complete the bootstrap.'
      );
    }

    // If pending for THIS email, let them through (retry after partial failure).
    // If status is absent/'none', claim it.

    tx.set(metaRef, {
      status: 'pending' as BootstrapStatus,
      firstAdminEmail: emailLower,
      firstAdminUid: uid,
      initiatedAt: metaData?.initiatedAt || FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  // Step 2: Idempotent side effects (safe to re-run).
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

  // Set custom claims on the user's auth profile.
  // If this fails, the meta stays 'pending' for this email — the user
  // can retry (the transaction will let them through because email matches).
  await auth.setCustomUserClaims(uid, {
    currentProject: { id: PROJECT_ID, role: 'admin' },
  });

  // Step 3: Mark complete. After this, the gate is permanently locked.
  await metaRef.set({
    status: 'complete' as BootstrapStatus,
    completedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return {
    projectId: PROJECT_ID,
    uid,
    email,
    mode: 'caller' as const,
  };
}
