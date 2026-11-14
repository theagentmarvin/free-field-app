// apps/users — SignInPage redirect (wave 64).
//
// An already-signed-in visitor is redirected with <Navigate> instead of
// a navigate() call during render (which React warns about).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({ user: null as { uid: string } | null }));

vi.mock('firebase/auth', () => ({ sendSignInLinkToEmail: vi.fn() }));
vi.mock('@ff/auth', () => ({
  useAuthContext: () => ({ auth: {} }),
  useAuth: () => ({ user: h.user, loading: false }),
}));

import { SignInPage } from '../src/auth/SignInPage';

afterEach(() => {
  cleanup();
  h.user = null;
});

function renderAt(state?: { from: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/sign-in', state }]}>
      <Routes>
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/" element={<div data-testid="home" />} />
        <Route path="/models" element={<div data-testid="models" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SignInPage', () => {
  it('shows the form when signed out', () => {
    renderAt();
    expect(screen.queryByTestId('home')).toBeNull();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('redirects a signed-in user to `from` without navigating during render', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.user = { uid: 'u1' };
    renderAt({ from: '/models' });
    expect(screen.getByTestId('models')).toBeInTheDocument();
    const calls = [...err.mock.calls, ...warn.mock.calls].flat().join(' ');
    expect(calls).not.toMatch(/navigate\(\)|while rendering|Cannot update a component/);
    err.mockRestore();
    warn.mockRestore();
  });

  it('redirects a signed-in user to / by default', () => {
    h.user = { uid: 'u1' };
    renderAt();
    expect(screen.getByTestId('home')).toBeInTheDocument();
  });
});
