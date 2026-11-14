// apps/users — InvitePage render test (real mode, plan v4 §3).
//
// The Cloud Function wrapper is stubbed; the render test only asserts
// the form renders (email input + role select + submit). No Firebase.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@ff/auth', () => ({
  useAuthContext: () => ({ app: {}, auth: {} }),
  useProjectId: () => 'p-test',
}));

vi.mock('../src/api', () => ({
  callInviteMember: vi.fn(),
  callSetMemberRole: vi.fn(),
  callRemoveMember: vi.fn(),
}));

import InvitePage from '../src/InvitePage';

describe('InvitePage', () => {
  it('renders the invite form (email, role select, submit)', () => {
    render(
      <MemoryRouter>
        <InvitePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Invite a member')).toBeInTheDocument();
    expect(screen.getByTestId('invite-form')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByText('Generate invite link')).toBeInTheDocument();
  });
});