import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailLink, isSignInWithEmailLink, type User } from 'firebase/auth';
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuthContext, useAuth, type AuthClaims } from '@ff/auth';

/** Cloud Functions region (VITE_FIREBASE_FUNCTIONS_REGION); unset = SDK default (us-central1). */
const FUNCTIONS_REGION: string | undefined =
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || undefined;

/**
 * /finish-sign-in — handles oobCode from email-link clicks.
 *
 * Per plan v3 §5.1 + task 29 F3:
 *   1. Verify the URL is a Firebase sign-in link
 *   2. Read email from localStorage (set by /sign-in)
 *   3. Call signInWithEmailLink(auth, email, link) — completes sign-in
 *   4. Write the own profile doc /users/{uid} (rules-pinned: self +
 *      email == token email) so the onCreateUser bootstrap reconciliation
 *      hook exists on the real path (P0-3). `createdAt` is written on
 *      create only.
 *   5. If the link carries `inviteId`, redeem it via the redeemInvitation
 *      callable. A failed redemption is shown as an error — never
 *      reported as a successful sign-in.
 *   6. ALWAYS refresh the claims (provider `refreshClaims()`) BEFORE
 *      branching — redemption AND the async bootstrap trigger both set
 *      claims server-side after the token was minted (P0-3, NEW-4).
 *   7. Branch by claim state:
 *      a) has currentProject → redirect to that role's default landing
 *      b) no currentProject (self-invite / no invitation) → /needs-invitation
 */
interface RedeemInvitationResult {
  status: string;
  projectId?: string;
  role?: string;
}

const EMAIL_KEY = 'emailForSignIn';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Emulator only: `handleCodeInApp` is unsupported there, so the emulator's
 * action handler may already have consumed the OOB code and signed the
 * user in. Accept that ONLY with the emulator flag on and a signed-in
 * user whose email matches the one this browser started the flow with.
 */
function emulatorAlreadySignedIn(current: User | null, email: string): current is User {
  return (
    import.meta.env.VITE_FIREBASE_USE_EMULATOR === 'true' &&
    current !== null &&
    (current.email ?? '').toLowerCase() === email.toLowerCase()
  );
}

export function FinishSignInPage() {
  const { app, auth } = useAuthContext();
  const { user, loading, refreshClaims } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [status, setStatus] = useState<'pending' | 'completing' | 'done'>('pending');
  const [freshClaims, setFreshClaims] = useState<AuthClaims | null>(null);
  // StrictMode runs effects twice in dev; an email link's oobCode is
  // single-use, so the second run must not try to sign in again.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    async function refresh(): Promise<void> {
      try {
        setFreshClaims(await refreshClaims());
      } catch {
        /* best effort — fall back to the provider's claims */
      }
    }

    async function completeSignIn() {
      const link = window.location.href;
      if (!isSignInWithEmailLink(auth, link)) {
        setError('This URL is not a valid sign-in link.');
        return;
      }
      const email = window.localStorage.getItem(EMAIL_KEY);
      if (!email) {
        // Email-link flow requires the same email entered at /sign-in. If
        // localStorage was cleared (different browser, private mode), the
        // user has to start over. Show a helpful message.
        setError(
          "We don't have your email in this browser. Go back to /sign-in and enter it again."
        );
        return;
      }

      setStatus('completing');
      let firebaseUser: User;
      try {
        const credential = await signInWithEmailLink(auth, email, link);
        firebaseUser = credential.user;
      } catch (err) {
        const current = auth.currentUser;
        if (emulatorAlreadySignedIn(current, email)) {
          firebaseUser = current;
        } else {
          setError(errorMessage(err));
          return;
        }
      }
      window.localStorage.removeItem(EMAIL_KEY);

      try {
        // (1) Write the own profile doc — rules pin email to the verified
        //     token identity, so this is safe and arms the onCreateUser
        //     bootstrap reconciliation hook on the real path (P0-3).
        //     `createdAt` is only written when the doc is created.
        if (firebaseUser.email) {
          const db = getFirestore(app);
          const ref = doc(db, 'users', firebaseUser.uid);
          const snap = await getDoc(ref);
          const base = { uid: firebaseUser.uid, email: firebaseUser.email };
          await setDoc(ref, snap.exists() ? base : { ...base, createdAt: Date.now() }, {
            merge: true,
          });
        }
      } catch (err) {
        setError(errorMessage(err));
        return;
      }

      // (2) Redeem the link-carried invitation (if any) BEFORE branching
      //     on claims — redemption sets the server-side claims this page
      //     branches on. Its failure is its own error, not a success.
      const inviteId = new URL(window.location.href).searchParams.get('inviteId');
      if (inviteId) {
        try {
          const redeem = httpsCallable<{ inviteId: string }, RedeemInvitationResult>(
            getFunctions(app, FUNCTIONS_REGION),
            'redeemInvitation'
          );
          await redeem({ inviteId });
        } catch (err) {
          await refresh();
          setRedeemError(errorMessage(err));
          return;
        }
      }

      // (3) ALWAYS refresh after the profile write so freshly-set claims
      //     (a redeemed invitation OR the async bootstrap trigger) are in
      //     the token and published to every consumer (NEW-4).
      await refresh();
      setStatus('done');
    }
    void completeSignIn();
    // Run once per mount: the sign-in link is single-use.
  }, []);

  // After sign-in completes, branch by claim state. We prefer the
  // freshly-fetched post-redemption claims.
  useEffect(() => {
    if (status !== 'done' || loading) return;
    if (!user) return;

    const claims = freshClaims ?? user.claims;
    const claim = claims.currentProject;
    if (claim?.id) {
      // Admin lands on settings (/) so they can author; member on /documents.
      const target = claim.role === 'admin' ? '/' : '/documents';
      navigate(target, { replace: true });
    } else {
      // Signed in but no project membership — self-invite or pending accept.
      navigate('/needs-invitation', { replace: true });
    }
  }, [status, user, loading, freshClaims, navigate]);

  if (error) {
    return (
      <div style={{ padding: 24, maxWidth: 480 }}>
        <h1>Sign-in error</h1>
        <p style={{ color: '#c00' }} role="alert">
          {error}
        </p>
        <p>
          <a href="/sign-in">Back to sign-in</a>
        </p>
      </div>
    );
  }

  if (redeemError) {
    return (
      <div style={{ padding: 24, maxWidth: 480 }} data-testid="redeem-error">
        <h1>Invitation not accepted</h1>
        <p>You are signed in, but we couldn&rsquo;t accept your invitation.</p>
        <p style={{ color: '#c00' }} role="alert">
          {redeemError}
        </p>
        <p>Ask the project admin to send a new invitation link.</p>
        <button
          type="button"
          onClick={() => {
            setRedeemError(null);
            setStatus('done');
          }}
        >
          Continue
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 480 }}>
      <h1>Completing sign-in…</h1>
      <p>One moment while we sign you in.</p>
    </div>
  );
}
