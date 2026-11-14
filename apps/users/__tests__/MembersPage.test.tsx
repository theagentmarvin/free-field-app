// apps/users — MembersPage render test (real mode, plan v4 §3).
//
// useMembers is stubbed to return a fixed list and the Cloud Function
// wrappers are stubbed, so this render test never touches Firebase.
// The signed-in user is u1 (an admin) so the self-demote / self-remove
// confirmations are under test.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({
  callInviteMember: vi.fn(),
  callSetMemberRole: vi.fn().mockResolvedValue(undefined),
  callRemoveMember: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@ff/auth', () => ({
  useAuthContext: () => ({ app: {}, auth: {} }),
  useAuth: () => ({
    user: { uid: 'u1', email: 'admin@example.com', emailVerified: true, claims: {} },
    loading: false,
  }),
  useProjectId: () => 'default-project',
  useIsAdmin: () => true,
}));

vi.mock('../src/hooks/useMembers', () => ({
  useMembers: () => [
    { uid: 'u1', email: 'admin@example.com', role: 'admin', status: 'active' },
    { uid: 'u2', email: 'member@example.com', role: 'member', status: 'active' },
  ],
}));

vi.mock('../src/api', () => api);

import MembersPage from '../src/MembersPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <MembersPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  api.callSetMemberRole.mockClear();
  api.callRemoveMember.mockClear();
});

describe('MembersPage', () => {
  it('renders the member list with email, role, status and actions', () => {
    renderPage();

    expect(screen.getByTestId('members-table')).toBeInTheDocument();
    expect(screen.getByText('admin@example.com')).toBeInTheDocument();
    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('member')).toBeInTheDocument();
    // Role toggle label inverts the current role.
    expect(screen.getByText('Make member')).toBeInTheDocument();
    expect(screen.getByText('Make admin')).toBeInTheDocument();
    expect(screen.getAllByText('Remove')).toHaveLength(2);
  });

  it('asks before an admin demotes themselves, and aborts on cancel', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    fireEvent.click(screen.getByText('Make member'));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('your own admin rights'));
    expect(api.callSetMemberRole).not.toHaveBeenCalled();
  });

  it('demotes themselves after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();

    fireEvent.click(screen.getByText('Make member'));

    await waitFor(() => expect(api.callSetMemberRole).toHaveBeenCalledWith({}, 'u1', 'member', 'default-project'));
  });

  it('promoting another member needs no confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    renderPage();

    fireEvent.click(screen.getByText('Make admin'));

    await waitFor(() => expect(api.callSetMemberRole).toHaveBeenCalledWith({}, 'u2', 'admin', 'default-project'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('warns specifically when an admin removes themselves', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();

    fireEvent.click(screen.getAllByText('Remove')[0]);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Remove yourself'));
    expect(api.callRemoveMember).not.toHaveBeenCalled();
  });

  it('names the CURRENT project in remove calls (a user may belong to several)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(screen.getAllByText('Remove')[1]);
    await waitFor(() =>
      expect(api.callRemoveMember).toHaveBeenCalledWith({}, 'u2', 'default-project'),
    );
  });
});
