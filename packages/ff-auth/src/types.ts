/**
 * Custom claims set by FreeField Cloud Functions. Locked shape (plan v4 §1):
 *
 *   { currentProject: { id: string; role: "admin" | "member" } }
 *
 * `role` is "admin" | "member" on the real (non-demo) path; the demo keeps
 * `role: string` so the synthetic demo identity (viewer/admin) still fits.
 * `superadmin` and `version` were dropped in v4 and must not reappear.
 */
export interface AuthClaims {
  currentProject?: { id: string; role: string } | null;
}

export interface AuthUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  claims: AuthClaims;
}

export interface CurrentProject {
  id: string;
  role: string;
  name?: string;
}
