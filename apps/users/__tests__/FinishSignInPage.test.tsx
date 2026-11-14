// apps/users — FinishSignInPage behavior tests (task 29 F3, task 31 NEW-4/NEW-6,
// wave 63 review fixes).
//
// Verifies the real-mode sign-in completion path:
//   - writes the own /users/{uid} profile doc (rules-pinned), with
//     `createdAt` on create only.
//   - redeems the link-carried inviteId via the callable; a failed
//     redemption is shown as an error and never navigates as success.
//   - ALWAYS refreshes the claims through the provider (even without
//     inviteId — NEW-4), BEFORE the claims-branching effect navigates.
//   - navigates to the target that reflects the FRESH claims snapshot.
//   - StrictMode's double effect run signs in only once.
//   - the "already signed in" fallback is emulator-only.

import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FinishSignInPage } from '../src/auth/FinishSignInPage';

const h = vi.hoisted(() => ({
  navigate: vi.fn(),
  setDoc: vi.fn().mockResolvedValue(undefined),
  getDoc: vi.fn(),
  profileExists: false,
  redeem: vi.fn(),
  refreshClaims: vi.fn(),
  signInWithEmailLink: vi.fn(),
  authCurrentUser: null as null | { uid: string; email: string },
  // Mutable per-test fixtures read at call time by the mocks below.
  useAuthClaims: {} as Record<string, unknown>,
  freshClaims: { currentProject: { id: 'default-project', role: 'member' } } as Record<
    string,
    unknown
  >,
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
}));

vi.mock('@ff/auth', () => ({
  useAuthContext: () => ({ app: { name: 'app' }, auth: { currentUser: h.authCurrentUser } }),
  useAuth: () => ({
    user: {
      uid: 'u1',
      email: 'test@example.com',
      emailVerified: true,
      claims: h.useAuthClaims,
    },
    loading: false,
    refreshClaims: h.refreshClaims,
  }),
}));

vi.mock('firebase/auth', () => ({
  isSignInWithEmailLink: () => true,
  signInWithEmailLink: h.signInWithEmailLink,
}));

vi.mock('firebase/firestore', () => ({
  getFirestore: () => ({}),
  doc: (_db: unknown, collection: string, id?: string) => ({ collection, id }),
  getDoc: h.getDoc,
  setDoc: h.setDoc,
}));

vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => h.redeem,
}));

beforeEach(() => {
  h.navigate.mockReset();
  h.setDoc.mockClear();
  h.profileExists = false;
  h.getDoc.mockReset().mockImplementation(async () => ({ exists: () => h.profileExists }));
  h.redeem.mockReset().mockResolvedValue({
    data: { status: 'accepted', projectId: 'default-project', role: 'member' },
  });
  h.refreshClaims.mockReset().mockImplementation(async () => h.freshClaims);
  h.signInWithEmailLink.mockReset();
  h.signInWithEmailLink.mockResolvedValue({
    user: { uid: 'u1', email: 'test@example.com' },
  });
  h.authCurrentUser = null;
  // Default fixtures: member claims only in the FRESH snapshot, so the
  // branch must come from refreshClaims — not the stale useAuth().claims.
  h.useAuthClaims = {};
  h.freshClaims = { currentProject: { id: 'default-project', role: 'member' } };
  window.localStorage.setItem('emailForSignIn', 'test@example.com');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FinishSignInPage (real mode)', () => {
  it('writes the own profile doc (createdAt on create) and redeems the inviteId', async () => {
    window.history.pushState({}, '', '/finish-sign-in?inviteId=abc123');

    render(<FinishSignInPage />);

    await waitFor(() => expect(h.setDoc).toHaveBeenCalled());
    await waitFor(() => expect(h.redeem).toHaveBeenCalledWith({ inviteId: 'abc123' }));
    await waitFor(() => expect(h.refreshClaims).toHaveBeenCalled());

    expect(h.setDoc).toHaveBeenCalledWith(
      expect.objectContaining({ collection: 'users', id: 'u1' }),
      expect.objectContaining({
        uid: 'u1',
        email: 'test@example.com',
        createdAt: expect.any(Number),
      }),
      { merge: true }
    );

    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/documents', { replace: true })
    );
  });

  it('does not overwrite createdAt when the profile doc already exists', async () => {
    h.profileExists = true;
    window.history.pushState({}, '', '/finish-sign-in');

    render(<FinishSignInPage />);

    await waitFor(() => expect(h.setDoc).toHaveBeenCalled());
    const written = h.setDoc.mock.calls[0][1] as Record<string, unknown>;
    expect(written).toEqual({ uid: 'u1', email: 'test@example.com' });
  });

  it('redeem and claims refresh both happen BEFORE navigate (call-order assertion)', async () => {
    window.history.pushState({}, '', '/finish-sign-in?inviteId=abc123');

    render(<FinishSignInPage />);

    await waitFor(() => expect(h.navigate).toHaveBeenCalled());

    const redeemOrder = h.redeem.mock.invocationCallOrder[0];
    const refreshOrder = h.refreshClaims.mock.invocationCallOrder[0];
    const navOrder = h.navigate.mock.invocationCallOrder[0];
    expect(redeemOrder).toBeLessThan(navOrder);
    expect(refreshOrder).toBeLessThan(navOrder);
  });

  it('navigates to /needs-invitation when there is no project claim', async () => {
    h.freshClaims = {};
    window.history.pushState({}, '', '/finish-sign-in');

    render(<FinishSignInPage />);

    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/needs-invitation', { replace: true })
    );
  });

  it('shows a failed invitation redemption as an error and does not navigate', async () => {
    h.redeem.mockRejectedValue(new Error('invitation expired'));
    window.history.pushState({}, '', '/finish-sign-in?inviteId=abc123');

    render(<FinishSignInPage />);

    expect(await screen.findByTestId('redeem-error')).toHaveTextContent('invitation expired');
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it('signs in only once under StrictMode (single-use link)', async () => {
    window.history.pushState({}, '', '/finish-sign-in');

    render(
      <StrictMode>
        <FinishSignInPage />
      </StrictMode>
    );

    await waitFor(() => expect(h.navigate).toHaveBeenCalled());
    expect(h.signInWithEmailLink).toHaveBeenCalledTimes(1);
  });

  it('emulator: a consumed OOB code with the same signed-in email proceeds (NEW-R3-2)', async () => {
    vi.stubEnv('VITE_FIREBASE_USE_EMULATOR', 'true');
    h.signInWithEmailLink.mockRejectedValue(new Error('emulator OOB consumed'));
    h.authCurrentUser = { uid: 'u1', email: 'test@example.com' };
    window.history.pushState({}, '', '/finish-sign-in?inviteId=abc123');

    render(<FinishSignInPage />);

    await waitFor(() => expect(h.refreshClaims).toHaveBeenCalled());
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/documents', { replace: true })
    );
  });

  it('outside the emulator a sign-in failure is an error even if someone is signed in', async () => {
    vi.stubEnv('VITE_FIREBASE_USE_EMULATOR', 'false');
    h.signInWithEmailLink.mockRejectedValue(new Error('auth/invalid-action-code'));
    h.authCurrentUser = { uid: 'u1', email: 'test@example.com' };
    window.history.pushState({}, '', '/finish-sign-in');

    render(<FinishSignInPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('auth/invalid-action-code');
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.setDoc).not.toHaveBeenCalled();
  });

  it('does NOT call redeemInvitation without an inviteId, but still refreshes claims (NEW-4)', async () => {
    window.history.pushState({}, '', '/finish-sign-in');

    render(<FinishSignInPage />);

    await waitFor(() => expect(h.setDoc).toHaveBeenCalled());
    expect(h.redeem).not.toHaveBeenCalled();
    await waitFor(() => expect(h.refreshClaims).toHaveBeenCalled());
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith('/documents', { replace: true })
    );
  });
});
