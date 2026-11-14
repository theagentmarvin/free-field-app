import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuthContext, useProjectId } from '@ff/auth';
import { callInviteMember, type InviteResult } from './api';

/**
 * InvitePage — /users/invite (admin-only, plan v4 §3).
 *
 * Email + role → Cloud Function creates a pending invitation doc and
 * returns the email-link URL. There is no "sent!" message in v4 — the
 * admin copies the link and forwards it manually (no SMTP).
 */
export default function InvitePage() {
  const { app } = useAuthContext();
  const projectId = useProjectId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!email.includes('@')) {
      setError('Enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await callInviteMember(app, email, role, projectId);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1>Invite a member</h1>
      <p>
        <Link to="/users" style={linkStyle}>
          Back to members
        </Link>
      </p>
      <form onSubmit={handleSubmit} data-testid="invite-form">
        <label>
          Email{' '}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            autoFocus
            style={{ padding: 8, width: 320, marginRight: 8 }}
          />
        </label>{' '}
        <label>
          Role{' '}
          <select
            value={role}
            onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}
            style={{ padding: 8 }}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>{' '}
        <button
          type="submit"
          disabled={busy || !email}
          style={{ padding: '8px 16px' }}
        >
          {busy ? 'Generating…' : 'Generate invite link'}
        </button>
      </form>
      {error && (
        <p role="alert" style={{ color: '#c00', marginTop: 12 }}>
          {error}
        </p>
      )}
      {result && (
        <div style={{ marginTop: 12 }} data-testid="invite-link">
          <p>
            Invitation for <strong>{result.email}</strong> (role: {result.role}).
            The link expires in 7 days — forward it manually to the user:
          </p>
          <input
            readOnly
            value={result.link}
            onFocus={(e) => e.target.select()}
            style={{ width: '100%', padding: 8, fontFamily: 'monospace' }}
            aria-label="Invitation link"
          />
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(result.link);
            }}
            style={{ marginTop: 8, padding: '6px 12px' }}
          >
            Copy link
          </button>
        </div>
      )}
    </div>
  );
}

const linkStyle = {
  color: '#0066cc',
};