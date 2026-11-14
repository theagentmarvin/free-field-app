// @vitest-environment node
/**
 * Integration tests for the FreeField user-module Cloud Functions (task 29).
 *
 * Runs under `firebase emulators:exec --only auth,firestore,functions` (see
 * the @ff/firestore `test` script). Tests make REAL callable HTTP calls
 * (wire format `{"data":{...}}`, bearer ID tokens) and create users via the
 * Auth emulator REST API / admin SDK.
 *
 * The two mandatory cases the critic demanded:
 *   - Promise.all double self-demotion: exactly one wins, ≥1 admin remains.
 *   - redeemInvitation with a forged caller email: DENY (no grant/overwrite).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
const AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
const FUNCTIONS_EMULATOR_HOST =
  process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST || 'localhost:5001';
// `firebase emulators:exec` sets GCLOUD_PROJECT; we fall back to the demo
// project id used by the package test script.
const EMULATOR_PROJECT = process.env.GCLOUD_PROJECT || 'demo-freefield';

const PROJECT_ID = 'default-project';
const PASSWORD = 'secret123';

if (getApps().length === 0) {
  initializeApp({ projectId: EMULATOR_PROJECT });
}
const auth = getAuth();
const db = getFirestore();

async function signInForIdToken(email: string): Promise<string> {
  const res = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
    }
  );
  const json = (await res.json()) as { idToken?: string; error?: { message?: string } };
  if (!res.ok || !json.idToken) {
    throw new Error(`signInWithPassword failed: ${JSON.stringify(json)}`);
  }
  return json.idToken;
}

interface CallableResponse {
  status: number;
  body: {
    result?: Record<string, unknown>;
    error?: { status?: string; message?: string; code?: string };
  };
}

async function callCallable(
  fnName: string,
  token: string | null,
  data?: unknown
): Promise<CallableResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(
    `http://${FUNCTIONS_EMULATOR_HOST}/${EMULATOR_PROJECT}/us-central1/${fnName}`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: data ?? {} }),
    }
  );
  const text = await res.text();
  let body: { result?: Record<string, unknown>; error?: { status?: string; message?: string } } =
    {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { result: { raw: text } };
  }
  return { status: res.status, body };
}

async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${EMULATOR_PROJECT}/databases/(default)/documents`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    throw new Error(`clearFirestore failed: ${res.status}`);
  }
}

async function createUser(email: string): Promise<{ uid: string; token: string }> {
  const user = await auth.createUser({ email, emailVerified: true, password: PASSWORD });
  const token = await signInForIdToken(email);
  return { uid: user.uid, token };
}

async function createAdmin(email: string): Promise<{ uid: string; token: string }> {
  const { uid, token } = await createUser(email);
  await auth.setCustomUserClaims(uid, {
    currentProject: { id: PROJECT_ID, role: 'admin' },
  });
  await db.doc(`projects/${PROJECT_ID}/members/${uid}`).set({
    role: 'admin',
    joinedAt: Date.now(),
    invitedBy: 'bootstrap',
    status: 'active',
  });
  // Re-auth to get a token that carries the fresh admin claim.
  const freshToken = await signInForIdToken(email);
  return { uid, token: freshToken };
}

beforeAll(async () => {
  await clearFirestore();
});

beforeEach(async () => {
  await clearFirestore();
});

// ────────────────────────────────────────────────────────────────────
// F2 — setMemberRole / removeMember last-admin guard (transactional)
// ────────────────────────────────────────────────────────────────────
describe('last-admin guard', () => {
  it('Promise.all double self-demotion: exactly one wins, exactly one active admin remains', async () => {
    const a = await createAdmin('admin-a@example.com');
    const b = await createAdmin('admin-b@example.com');

    const [ra, rb] = await Promise.all([
      callCallable('setMemberRole', a.token, { uid: a.uid, role: 'member' }),
      callCallable('setMemberRole', b.token, { uid: b.uid, role: 'member' }),
    ]);

    const winners = [ra, rb].filter((r) => r.body.result !== undefined);
    const losers = [ra, rb].filter((r) => r.body.error !== undefined);

    // Exactly one of the two concurrent self-demotions may succeed.
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    // The loser must be rejected as the last-admin guard (failed-precondition).
    expect(losers[0].body.error?.status).toBe('FAILED_PRECONDITION');

    const admins = await db
      .collection(`projects/${PROJECT_ID}/members`)
      .where('role', '==', 'admin')
      .get();
    const activeAdmins = admins.docs.filter((d) => d.get('status') !== 'removed');
    expect(activeAdmins.length).toBe(1);
  });

  it('mutual demotion: A demotes B while B demotes A — exactly one wins, ≥1 admin remains', async () => {
    const a = await createAdmin('mutual-a@example.com');
    const b = await createAdmin('mutual-b@example.com');

    const [ra, rb] = await Promise.all([
      callCallable('setMemberRole', a.token, { uid: b.uid, role: 'member' }),
      callCallable('setMemberRole', b.token, { uid: a.uid, role: 'member' }),
    ]);

    const winners = [ra, rb].filter((r) => r.body.result !== undefined);
    const losers = [ra, rb].filter((r) => r.body.error !== undefined);
    // Exactly one of the two concurrent mutual demotions may win; the other
    // is rejected (its caller is no longer an admin, or the last-admin guard).
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);

    const admins = await db
      .collection(`projects/${PROJECT_ID}/members`)
      .where('role', '==', 'admin')
      .get();
    const activeAdmins = admins.docs.filter((d) => d.get('status') !== 'removed');
    expect(activeAdmins.length).toBeGreaterThanOrEqual(1); // ≥1 active admin invariant holds
    expect(activeAdmins.length).toBe(1); // two admins, one demotion lands → exactly one remains
  });

  it('removeMember of the last admin is refused inside the transaction', async () => {
    const only = await createAdmin('only-admin@example.com');

    const res = await callCallable('removeMember', only.token, { uid: only.uid });
    expect(res.body.error?.status).toBe('FAILED_PRECONDITION');

    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${only.uid}`)
      .get();
    expect(member.exists).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// F3 — redeemInvitation (link-carried inviteId, verified-email grant)
// ────────────────────────────────────────────────────────────────────
describe('redeemInvitation', () => {
  it('grants membership + claims via a link-carried inviteId for the verified email', async () => {
    const owner = await createAdmin('owner@example.com');
    const inviteeEmail = 'invitee@example.com';
    const invitee = await createUser(inviteeEmail);

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: inviteeEmail,
        role: 'member',
        invitedBy: owner.uid,
        invitedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending',
      });

    const res = await callCallable('redeemInvitation', invitee.token, {
      inviteId: inviteRef.id,
    });
    expect(res.body.result?.status).toBe('accepted');

    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${invitee.uid}`)
      .get();
    expect(member.exists).toBe(true);
    expect(member.get('role')).toBe('member');

    const inv = await db
      .doc(`projects/${PROJECT_ID}/invitations/${inviteRef.id}`)
      .get();
    expect(inv.get('status')).toBe('accepted');
    expect(inv.get('acceptedBy')).toBe(invitee.uid);

    const rec = await auth.getUser(invitee.uid);
    expect(rec.customClaims?.currentProject).toEqual({
      id: PROJECT_ID,
      role: 'member',
    });
  });

  it('DENIES a forged caller email: no grant, no member doc, no accepted mark', async () => {
    const owner = await createAdmin('owner2@example.com');
    const victimEmail = 'victim@example.com';

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: victimEmail,
        role: 'admin',
        invitedBy: owner.uid,
        invitedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending',
      });

    // The attacker signs in with their OWN verified email and tries to
    // redeem the invitation addressed to the victim.
    const attacker = await createUser('attacker@example.com');

    const res = await callCallable('redeemInvitation', attacker.token, {
      inviteId: inviteRef.id,
    });
    expect(res.body.result?.status).toBe('nothing-to-redeem');

    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${attacker.uid}`)
      .get();
    expect(member.exists).toBe(false);

    const inv = await db
      .doc(`projects/${PROJECT_ID}/invitations/${inviteRef.id}`)
      .get();
    expect(inv.get('status')).toBe('pending');

    const rec = await auth.getUser(attacker.uid);
    expect(rec.customClaims?.currentProject).toBeUndefined();
  });

  it('DENIES an unverified caller email: no grant, invitation stays pending', async () => {
    const owner = await createAdmin('owner-unverified@example.com');
    const inviteeEmail = 'unverified@example.com';

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: inviteeEmail,
        role: 'member',
        invitedBy: owner.uid,
        invitedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending',
      });

    // Password sign-up path: same mailbox, but the email is NOT verified.
    const unverified = await auth.createUser({
      email: inviteeEmail,
      emailVerified: false,
      password: PASSWORD,
    });
    const token = await signInForIdToken(inviteeEmail);

    const res = await callCallable('redeemInvitation', token, {
      inviteId: inviteRef.id,
    });
    expect(res.body.result?.status).toBe('nothing-to-redeem');

    // Invitation stays pending.
    const inv = await db
      .doc(`projects/${PROJECT_ID}/invitations/${inviteRef.id}`)
      .get();
    expect(inv.get('status')).toBe('pending');

    // No member doc.
    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${unverified.uid}`)
      .get();
    expect(member.exists).toBe(false);

    // No claims.
    const rec = await auth.getUser(unverified.uid);
    expect(rec.customClaims?.currentProject).toBeUndefined();
  });

  it('DENIES an expired invitation (no grant)', async () => {
    const owner = await createAdmin('owner3@example.com');
    const inviteeEmail = 'expired@example.com';
    const invitee = await createUser(inviteeEmail);

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: inviteeEmail,
        role: 'member',
        invitedBy: owner.uid,
        invitedAt: Date.now() - 10_000,
        expiresAt: Date.now() - 1_000,
        status: 'pending',
      });

    const res = await callCallable('redeemInvitation', invitee.token, {
      inviteId: inviteRef.id,
    });
    expect(res.body.result?.status).toBe('nothing-to-redeem');

    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${invitee.uid}`)
      .get();
    expect(member.exists).toBe(false);
  });

  it('does not overwrite an existing membership on redemption', async () => {
    const owner = await createAdmin('owner4@example.com');
    const memberEmail = 'existing@example.com';
    const existing = await createUser(memberEmail);

    // Pre-existing membership (e.g. already a member of this project).
    await db.doc(`projects/${PROJECT_ID}/members/${existing.uid}`).set({
      role: 'member',
      joinedAt: Date.now(),
      invitedBy: 'bootstrap',
      status: 'active',
    });

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: memberEmail,
        role: 'admin',
        invitedBy: owner.uid,
        invitedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending',
      });

    const res = await callCallable('redeemInvitation', existing.token, {
      inviteId: inviteRef.id,
    });
    // Nothing further is granted.
    expect(res.body.result?.status).toBe('nothing-to-redeem');

    // The existing role must NOT be overwritten with the invitation's role.
    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${existing.uid}`)
      .get();
    expect(member.get('role')).toBe('member');

    // The invitation is closed so it can't be redeemed later.
    const inv = await db
      .doc(`projects/${PROJECT_ID}/invitations/${inviteRef.id}`)
      .get();
    expect(inv.get('status')).toBe('accepted');
  });

  it('revokes an orphaned invitation whose inviter was removed — the ghost-admin case (NEW-R3-1)', async () => {
    // X (an admin) creates an invitation for ghost-alt, then X is removed
    // (member doc deleted — what removeMember does inside its transaction).
    const inviter = await createAdmin('ghost-inviter@example.com');
    const ghostEmail = 'ghost-alt@example.com';
    const ghost = await createUser(ghostEmail);

    const inviteRef = await db
      .collection(`projects/${PROJECT_ID}/invitations`)
      .add({
        email: ghostEmail,
        role: 'admin',
        invitedBy: inviter.uid,
        invitedAt: Date.now(),
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
        status: 'pending',
      });

    // Remove the inviter: delete their member doc exactly as removeMember does.
    await db
      .doc(`projects/${PROJECT_ID}/members/${inviter.uid}`)
      .delete();

    // The ghost account (the invitation's recipient) redeems → must not grant.
    const res = await callCallable('redeemInvitation', ghost.token, {
      inviteId: inviteRef.id,
    });
    expect(res.body.result?.status).toBe('nothing-to-redeem');

    // No member doc was created for the ghost account.
    const member = await db
      .doc(`projects/${PROJECT_ID}/members/${ghost.uid}`)
      .get();
    expect(member.exists).toBe(false);

    // No admin claims were minted.
    const rec = await auth.getUser(ghost.uid);
    expect(rec.customClaims?.currentProject).toBeUndefined();

    // The orphaned invitation is revoked, not left pending or accepted.
    const inv = await db
      .doc(`projects/${PROJECT_ID}/invitations/${inviteRef.id}`)
      .get();
    expect(inv.get('status')).toBe('revoked');
    expect(inv.get('revokedReason')).toBe('orphaned-inviter');
  });
});
// ────────────────────────────────────────────────────────────────────
// Wave 63 — bootstrapFirstAdmin caller mode (B) is gated
// (`.env.demo-freefield` allowlists bootstrap-allowed@example.com)
// ────────────────────────────────────────────────────────────────────
describe('bootstrapFirstAdmin caller mode gate', () => {
  async function createUnverified(email: string): Promise<{ uid: string; token: string }> {
    const user = await auth.createUser({ email, emailVerified: false, password: PASSWORD });
    return { uid: user.uid, token: await signInForIdToken(email) };
  }

  it('DENIES a verified signed-in caller who is not allowlisted and has no secret', async () => {
    const u = await createUser(`stranger-${Date.now()}@example.com`);
    const res = await callCallable('bootstrapFirstAdmin', u.token);
    expect(res.body.error?.status).toBe('PERMISSION_DENIED');
    expect((await db.doc('meta/bootstrap').get()).exists).toBe(false);
    expect((await db.doc(`projects/${PROJECT_ID}/members/${u.uid}`).get()).exists).toBe(false);
    expect((await auth.getUser(u.uid)).customClaims?.currentProject).toBeUndefined();
  });

  it('DENIES a wrong bootstrap secret', async () => {
    const u = await createUser(`guesser-${Date.now()}@example.com`);
    const res = await callCallable('bootstrapFirstAdmin', u.token, { bootstrapSecret: 'guess' });
    expect(res.body.error?.status).toBe('PERMISSION_DENIED');
    expect((await db.doc('meta/bootstrap').get()).exists).toBe(false);
  });

  it('DENIES a caller whose email is not verified', async () => {
    // The allowlisted+unverified combination is covered by the gate unit
    // tests (the allowlisted address is reserved for the success case).
    const u = await createUnverified(`unverified-${Date.now()}@example.com`);
    const res = await callCallable('bootstrapFirstAdmin', u.token);
    expect(res.body.error?.status).toBe('PERMISSION_DENIED');
    expect((await db.doc('meta/bootstrap').get()).exists).toBe(false);
  });

  it('allows the allowlisted verified email to bootstrap exactly once', async () => {
    let u: { uid: string; token: string };
    try {
      u = await createUser('bootstrap-allowed@example.com');
    } catch {
      // Auth emulator state survives across runs within one emulator session.
      const existing = await auth.getUserByEmail('bootstrap-allowed@example.com');
      await auth.setCustomUserClaims(existing.uid, null);
      u = { uid: existing.uid, token: await signInForIdToken('bootstrap-allowed@example.com') };
    }
    const res = await callCallable('bootstrapFirstAdmin', u.token);
    expect(res.body.error).toBeUndefined();
    expect(res.body.result?.mode).toBe('caller');
    expect((await db.doc('meta/bootstrap').get()).get('status')).toBe('complete');
    const member = await db.doc(`projects/${PROJECT_ID}/members/${u.uid}`).get();
    expect(member.get('role')).toBe('admin');

    // Second attempt is refused — the gate is locked.
    const again = await callCallable('bootstrapFirstAdmin', u.token);
    expect(again.body.error?.status).toBe('FAILED_PRECONDITION');
  });
});
