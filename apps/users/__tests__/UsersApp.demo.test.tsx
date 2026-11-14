// apps/users — demo-mode content for the Users module (plan v4 amendment v4.1).
//
// In demo mode the Users page shows a mock member table instead of the
// Phase-0 placeholder: the two demo identities (admin@demo / guest@demo)
// so the thesis demo can show the role difference without Firebase.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { AuthProvider, setDemoRole } from '@ff/auth';

import UsersApp from '../src/UsersApp';

function renderUsers() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <UsersApp />
      </MemoryRouter>
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.stubEnv('VITE_FF_DEMO_AUTH', 'true');
  localStorage.clear();
  setDemoRole('viewer');
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('UsersApp in demo mode', () => {
  it('renders the mock member table instead of the Phase-0 placeholder', () => {
    renderUsers();

    expect(screen.getByTestId('users-demo-table')).toBeInTheDocument();
    expect(screen.getByText(/admin@demo/)).toBeInTheDocument();
    expect(screen.getByText(/guest@demo/)).toBeInTheDocument();
    expect(screen.getByText('admin')).toBeInTheDocument();
    expect(screen.getByText('viewer')).toBeInTheDocument();
    expect(screen.queryByText(/Phase 0 skeleton/)).toBeNull();
  });

  it('notes that real invitations arrive with Firebase auth (Wave B)', () => {
    renderUsers();

    expect(
      screen.getByText('Real invitations arrive with Firebase auth (Wave B)'),
    ).toBeInTheDocument();
  });

  it('marks the demo viewer as "you"', () => {
    setDemoRole('viewer');
    renderUsers();

    expect(screen.getByTestId('users-demo-row-viewer')).toHaveTextContent(
      'guest@demo (you)',
    );
    expect(screen.getByTestId('users-demo-row-admin')).not.toHaveTextContent(
      '(you)',
    );
  });

  it('marks the demo admin as "you"', () => {
    setDemoRole('admin');
    renderUsers();

    expect(screen.getByTestId('users-demo-row-admin')).toHaveTextContent(
      'admin@demo (you)',
    );
    expect(screen.getByTestId('users-demo-row-viewer')).not.toHaveTextContent(
      '(you)',
    );
  });
});
