import { getFunctions, httpsCallable } from 'firebase/functions';
import type { FirebaseApp } from 'firebase/app';

/** Cloud Functions region (VITE_FIREBASE_FUNCTIONS_REGION); unset = SDK default (us-central1). */
const FUNCTIONS_REGION: string | undefined =
  import.meta.env.VITE_FIREBASE_FUNCTIONS_REGION || undefined;

/**
 * Thin wrappers around the user-module Cloud Functions (plan v4 §3).
 * They live here so MembersPage / InvitePage stay dumb renderers and
 * tests can stub this module without touching Firebase.
 */

export interface InviteResult {
  invitationId: string;
  email: string;
  role: 'admin' | 'member';
  link: string;
  expiresAt: number;
}

export async function callInviteMember(
  app: FirebaseApp,
  email: string,
  role: 'admin' | 'member',
  projectId?: string
): Promise<InviteResult> {
  const fn = httpsCallable<
    { email: string; role: 'admin' | 'member'; projectId?: string },
    InviteResult
  >(getFunctions(app, FUNCTIONS_REGION), 'inviteMember');
  // Phase 1b: name the project explicitly — a user may belong to several,
  // and the server authorizes from the member doc of THIS project.
  const res = await fn({ email, role, projectId });
  return res.data;
}

export async function callSetMemberRole(
  app: FirebaseApp,
  uid: string,
  role: 'admin' | 'member',
  projectId?: string
): Promise<void> {
  const fn = httpsCallable<{ uid: string; role: 'admin' | 'member'; projectId?: string }, unknown>(
    getFunctions(app, FUNCTIONS_REGION),
    'setMemberRole'
  );
  await fn({ uid, role, projectId });
}

export async function callRemoveMember(
  app: FirebaseApp,
  uid: string,
  projectId?: string
): Promise<void> {
  const fn = httpsCallable<{ uid: string; projectId?: string }, unknown>(
    getFunctions(app, FUNCTIONS_REGION),
    'removeMember'
  );
  await fn({ uid, projectId });
}

/**
 * Admin-only (SPEC-PHASE-1 Q2): creates a project and makes the caller its
 * first admin. Returns the generated project id; the caller then switches
 * to it with `switchProject(id)` once the membership listener has it.
 */
export async function callCreateProject(
  app: FirebaseApp,
  name: string
): Promise<{ projectId: string; name: string }> {
  const fn = httpsCallable<{ name: string }, { projectId: string; name: string }>(
    getFunctions(app, FUNCTIONS_REGION),
    'createProject'
  );
  const res = await fn({ name });
  return res.data;
}