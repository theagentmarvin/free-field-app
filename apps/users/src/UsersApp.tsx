import { Routes, Route, Navigate } from 'react-router-dom';
import { isDemoAuth, useAuth, useRole } from '@ff/auth';
import MembersPage from './MembersPage';
import InvitePage from './InvitePage';

/**
 * Users module root, mounted at /users in MainShell (admin-only).
 *
 * Real mode (plan v4 §3):
 * - index → MembersPage (live member list + role toggle + remove)
 * - invite → InvitePage (email + role → Cloud Function → email link)
 *
 * Demo mode (plan v4 amendment v4.1): a mock member table replaces the
 * real pages so the thesis demo can show the role difference (admin vs
 * viewer) without any Firebase backend.
 */

interface DemoMember {
  email: string;
  role: 'admin' | 'viewer';
}

const DEMO_MEMBERS: DemoMember[] = [
  { email: 'admin@demo', role: 'admin' },
  { email: 'guest@demo', role: 'viewer' },
];

export default function UsersApp() {
  const { user, loading } = useAuth();

  if (isDemoAuth()) {
    return (
      <Routes>
        <Route index element={<UsersDemoHome />} />
      </Routes>
    );
  }

  if (loading) {
    return null;
  }

  if (!user) {
    return <Navigate to="/sign-in" replace />;
  }

  return (
    <Routes>
      <Route index element={<MembersPage />} />
      <Route path="invite" element={<InvitePage />} />
    </Routes>
  );
}

/**
 * Demo member table. The "(you)" marker follows the current demo role
 * (the mocked sign-in identity).
 */
function UsersDemoHome() {
  const role = useRole();

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h1>Users</h1>
      <p>Demo mode — mocked sign-in. These are the demo identities:</p>
      <table
        data-testid="users-demo-table"
        style={{ borderCollapse: 'collapse', marginTop: 8 }}
      >
        <thead>
          <tr>
            <th style={cellStyle}>Email</th>
            <th style={cellStyle}>Role</th>
          </tr>
        </thead>
        <tbody>
          {DEMO_MEMBERS.map((member) => (
            <tr key={member.email} data-testid={`users-demo-row-${member.role}`}>
              <td style={cellStyle}>
                {member.email}
                {member.role === role ? ' (you)' : ''}
              </td>
              <td style={cellStyle}>{member.role}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ color: '#666', marginTop: 16 }}>
        Real invitations arrive with Firebase auth (Wave B)
      </p>
    </div>
  );
}

const cellStyle = {
  border: '1px solid var(--ff-border, #e5e7eb)',
  padding: '4px 10px',
  textAlign: 'left' as const,
};
