import { useState } from 'react';
import { httpsCallable } from 'firebase/functions';
import { getFunctions } from 'firebase/functions';
import { useAuth, useAuthContext } from '@ff/auth';

/** Cloud Functions region (VITE_FIREBASE_FUNCTIONS_REGION); unset = SDK default (us-central1). */
const FUNCTIONS_REGION: string | undefined =
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || undefined;

/**
 * /needs-invitation — landing for signed-in users without project membership.
 *
 * Per plan v3 §5.1 step 4b + §5.2 step 4d: when a user signs in via email-link
 * without a matching pending invitation, they land here.
 *
 * Bootstrap is handled server-side by the `bootstrapFirstAdmin` Cloud Function.
 * The function enforces a singleton gate (/meta/bootstrap.firstAdminBootstrapped)
 * so only the first user can bootstrap. All Firestore writes + custom-claims
 * assignment happen inside the function — the client never writes directly.
 */
export function NeedsInvitationPage() {
  const { user, firebaseUser } = useAuth();
  const { app } = useAuthContext();
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<string | null>(null);

  async function handleBootstrap() {
    setBootstrapping(true);
    setBootstrapResult(null);
    try {
      const functions = getFunctions(app, FUNCTIONS_REGION);
      const bootstrapFn = httpsCallable(functions, 'bootstrapFirstAdmin');

      // Call with no data — the function reads the caller's auth context.
      await bootstrapFn();

      setBootstrapResult(
        '✅ Bootstrap complete! Refreshing your session…'
      );

      // Force-refresh the ID token so custom claims (currentProject)
      // are picked up immediately. Without this, the user would see
      // the dashboard until their next token refresh (up to 1 hour).
      if (firebaseUser) {
        await firebaseUser.getIdToken(true);
      }

      // Reload to pick up the new claims in useAuth.
      window.location.reload();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      setBootstrapResult('❌ ' + message);
      setBootstrapping(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 560 }}>
      <h1>You need an invitation</h1>
      <p>
        You're signed in as <strong>{user?.email ?? 'unknown'}</strong>.
        This FreeField deployment doesn't have any projects yet, or you
        don't have access to one.
      </p>
      <p>
        FreeField is invite-only. If this is a new deployment, the first
        admin must bootstrap the project:
      </p>
      <div style={{ marginTop: 24 }}>
        <button
          type="button"
          onClick={handleBootstrap}
          disabled={bootstrapping}
          style={{ padding: '8px 16px', fontSize: 14, marginRight: 12 }}
        >
          {bootstrapping ? 'Bootstrapping…' : 'Bootstrap as First Admin'}
        </button>
      </div>
      {bootstrapResult && (
        <p
          style={{
            marginTop: 12,
            color: bootstrapResult.startsWith('✅') ? '#060' : '#c00',
          }}
        >
          {bootstrapResult}
        </p>
      )}
      <p style={{ color: '#666', marginTop: 24, fontSize: 13 }}>
        If someone already invited you, ask them to resend the invitation.
        To sign out, use the user menu (top right) and choose "Sign out."
      </p>
    </div>
  );
}
