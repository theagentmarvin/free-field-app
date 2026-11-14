import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { sendSignInLinkToEmail } from 'firebase/auth';
import { useAuthContext, useAuth } from '@ff/auth';

/**
 * /sign-in — public route. Email-link only per plan v3 §5.1.
 *
 * Flow:
 *   1. User enters email
 *   2. App calls signInWithEmailLink(auth, email)  — v11 public signature: 3rd arg is `emailLink?: string` for sign-in completion (see FinishSignInPage), NOT an ActionCodeSettings object. Server-side continueUrl is configured via Firebase Auth console / ActionCodeSettings at admin time.
 *   3. Firebase sends the email
 *   4. App shows "check your inbox" message
 *   5. User clicks the link → lands on /finish-sign-in?oobCode=...
 */
export function SignInPage() {
  const { auth } = useAuthContext();
  const { user, loading } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);


  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address');
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Emulator: handleCodeInApp is unsupported; the emulator always
      // completes OOB via the /emulator/action web handler.
      const isEmulator = import.meta.env.VITE_FIREBASE_USE_EMULATOR === 'true';
      await sendSignInLinkToEmail(auth, email, {
        url: `${window.location.origin}/finish-sign-in`,
        handleCodeInApp: !isEmulator,
      });
      // Persist email for /finish-sign-in (Firebase Auth requires it to complete).
      window.localStorage.setItem('emailForSignIn', email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  // If already signed in, redirect away. Declarative <Navigate> (wave 64):
  // calling navigate() during render is a React side-effect-in-render bug.
  if (!loading && user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  if (sent) {
    return (
      <div style={{ padding: 24, maxWidth: 480 }}>
        <h1>Check your email</h1>
        <p>
          We've sent a sign-in link to <strong>{email}</strong>. Click the link to
          continue. The link expires after a few hours.
        </p>
        <p style={{ color: '#666' }}>
          Didn't get it? Check your spam folder, or{' '}
          <button
            type="button"
            onClick={() => {
              setSent(false);
              setEmail('');
            }}
            style={{ background: 'none', border: 'none', color: '#0066cc', cursor: 'pointer', textDecoration: 'underline' }}
          >
            try again
          </button>
          .
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 480 }}>
      <img
        src="/brand/freefield-mark.svg"
        alt="FreeField"
        width={64}
        height={80}
        style={{ display: 'block', marginBottom: 8 }}
      />
      <h1>Sign in to FreeField</h1>
      <p>Enter your email — we'll send you a one-time sign-in link.</p>
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoComplete="email"
          autoFocus
          style={{ width: '100%', padding: 8, marginBottom: 12, fontSize: 16 }}
        />
        <button
          type="submit"
          disabled={sending || !email}
          style={{
            padding: '8px 16px',
            fontSize: 16,
            cursor: sending ? 'wait' : 'pointer',
          }}
        >
          {sending ? 'Sending…' : 'Send sign-in link'}
        </button>
      </form>
      {error && (
        <p style={{ color: '#c00', marginTop: 12 }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}