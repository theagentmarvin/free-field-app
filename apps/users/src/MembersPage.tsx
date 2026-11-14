import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useAuthContext, useProjectId } from '@ff/auth';
import { useMembers, type MemberRow } from './hooks/useMembers';
import { callRemoveMember, callSetMemberRole } from './api';

/**
 * MembersPage — the /users index route (admin-only, plan v4 §3).
 *
 * Live list of members (email, role, status) with a per-row role toggle
 * (admin ↔ member) and remove action. All mutations go through the
 * server Cloud Functions, which enforce the last-admin guard.
 */
export default function MembersPage() {
  const { app } = useAuthContext();
  const { user } = useAuth();
  const projectId = useProjectId();
  const members = useMembers();
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRoleToggle(member: MemberRow) {
    const isSelf = member.uid === user?.uid;
    if (
      isSelf &&
      member.role === 'admin' &&
      !window.confirm(
        'Remove your own admin rights? You will lose access to Settings and Users ' +
          'until another admin promotes you again.'
      )
    ) {
      return;
    }
    setBusyUid(member.uid);
    setError(null);
    try {
      await callSetMemberRole(app, member.uid, member.role === 'admin' ? 'member' : 'admin', projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUid(null);
    }
  }

  async function handleRemove(member: MemberRow) {
    const isSelf = member.uid === user?.uid;
    const message = isSelf
      ? 'Remove yourself from the project? You will lose access to it immediately.'
      : `Remove ${member.email} from the project?`;
    if (!window.confirm(message)) return;
    setBusyUid(member.uid);
    setError(null);
    try {
      await callRemoveMember(app, member.uid, projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 760 }}>
      <h1>Members</h1>
      <p>
        <Link to="invite" style={linkStyle}>
          Invite a member
        </Link>
      </p>
      {error && (
        <p role="alert" style={{ color: '#c00' }}>
          {error}
        </p>
      )}
      {members === undefined ? (
        <p>Loading members…</p>
      ) : members.length === 0 ? (
        <p>No members yet.</p>
      ) : (
        <table data-testid="members-table" style={tableStyle}>
          <thead>
            <tr>
              <th style={cellStyle}>Email</th>
              <th style={cellStyle}>Role</th>
              <th style={cellStyle}>Status</th>
              <th style={cellStyle} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.uid} data-testid={`member-row-${member.uid}`}>
                <td style={cellStyle}>{member.email}</td>
                <td style={cellStyle}>{member.role}</td>
                <td style={cellStyle}>{member.status}</td>
                <td style={cellStyle}>
                  <button
                    type="button"
                    onClick={() => handleRoleToggle(member)}
                    disabled={busyUid === member.uid}
                  >
                    {member.role === 'admin' ? 'Make member' : 'Make admin'}
                  </button>{' '}
                  <button
                    type="button"
                    onClick={() => handleRemove(member)}
                    disabled={busyUid === member.uid}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle = {
  borderCollapse: 'collapse' as const,
  marginTop: 8,
  width: '100%' as const,
};

const cellStyle = {
  border: '1px solid var(--ff-border, #e5e7eb)',
  padding: '4px 10px',
  textAlign: 'left' as const,
};

const linkStyle = {
  color: '#0066cc',
};