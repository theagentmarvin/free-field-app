// apps/users — the non-demo UsersApp path renders the real admin pages.
//
// With demo mode OFF, the Users module renders MembersPage (the live
// member table) at the index route instead of the Phase-0 placeholder
// or the demo mock table.
//
// @ff/auth is shimmed (same pattern as apps/documents/__tests__/setup.ts),
// and useMembers / api are stubbed so the render test does not touch
// Firebase. Task 26's demo tests cover the demo branch; this file pins
// the real branch.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@ff/auth', () => {
  const user = {
    uid: 'test-admin',
    email: 'admin@example.com',
    emailVerified: true,
    claims: { currentProject: { id: 'default-project', role: 'admin' } },
  };
  return {
    isDemoAuth: () => false,
    useAuth: () => ({
      user,
      firebaseUser: user,
      loading: false,
      error: null,
    }),
    useRole: () => 'admin',
    useAuthContext: () => ({ app: {}, auth: {} }),
    useProjectId: () => 'default-project',
    useIsAdmin: () => true,
    AuthProvider: ({ children }: { children?: unknown }) => children,
    RequireAuth: ({ children }: { children?: unknown }) => children,
    RequireAdmin: ({ children }: { children?: unknown }) => children,
    RequireProjectMember: ({ children }: { children?: unknown }) => children,
  };
});

vi.mock('../src/hooks/useMembers', () => ({
  useMembers: () => [
    { uid: 'u1', email: 'admin@example.com', role: 'admin', status: 'active' },
    { uid: 'u2', email: 'member@example.com', role: 'member', status: 'active' },
  ],
}));

vi.mock('../src/api', () => ({
  callInviteMember: vi.fn(),
  callSetMemberRole: vi.fn(),
  callRemoveMember: vi.fn(),
}));

import UsersApp from '../src/UsersApp';

describe('UsersApp without demo mode', () => {
  it('renders the real MembersPage (not the mock member table)', () => {
    render(
      <MemoryRouter initialEntries={['/users']}>
        <Routes>
          <Route path="/users/*" element={<UsersApp />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    expect(screen.queryByTestId('users-demo-table')).toBeNull();
  });
});