import { useAuthContext } from '../AuthProvider';
import type { AuthClaims, AuthUser } from '../types';

export type { AuthClaims, AuthUser };

/**
 * Returns the current Firebase user plus their custom claims.
 *
 * The user and claims are resolved ONCE by <AuthProvider> (one
 * `onAuthStateChanged` listener, one forced token refresh per sign-in)
 * and shared by every consumer; this hook only reads the context.
 *
 * `loading` stays true until both the auth state and the signed-in
 * user's claims are known. Guards MUST wait for it before deciding a
 * redirect — otherwise users with valid claims get bounced to
 * /needs-invitation during the gap between auth and claims.
 *
 * Demo mode (VITE_FF_DEMO_AUTH=true): there is no Firebase user at all.
 * The provider exposes a synthetic identity for the current demo role
 * (admin@demo / guest@demo) and `loading` is always false.
 */
export function useAuth() {
  const { user, firebaseUser, loading, error, refreshClaims, signOut } = useAuthContext();
  return { user, firebaseUser, loading, error, refreshClaims, signOut };
}
