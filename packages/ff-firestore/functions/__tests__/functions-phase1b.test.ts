// @vitest-environment node
/**
 * Phase 1b function tests (docs/SPEC-PHASE-1.md §2, §3): N memberships.
 * Same emulator harness as functions.test.ts (real callable HTTP calls).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

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


async function seedMember(
  pid: string,
  uid: string,
  role: 'admin' | 'member',
  status = 'active'
): Promise<void> {
  await db.doc(`projects/${pid}`).set({ name: pid, createdBy: 'seed', createdAt: Timestamp.now() });
  await db.doc(`projects/${pid}/members/${uid}`).set({
    uid,
    role,
    status,
    joinedAt: Timestamp.now(),
    invitedBy: 'bootstrap',
  });
}

async function user(email: string, claim?: { id: string; role: string }) {
  const u = await auth.createUser({ email, emailVerified: true, password: PASSWORD });
  if (claim) await auth.setCustomUserClaims(u.uid, { currentProject: claim });
  return { uid: u.uid, token: await signInForIdToken(email) };
}

beforeEach(async () => {
  await clearFirestore();
});

describe('createProject', () => {
  it('an admin creates a project: project doc + creator admin member doc (uid, Timestamp joinedAt)', async () => {
    const admin = await user('cp-admin@example.com');
    await seedMember('existing', admin.uid, 'admin');

    const res = await callCallable('createProject', admin.token, { name: '  Tower B  ' });
    const projectId = res.body.result?.projectId as string;
    expect(typeof projectId).toBe('string');
    expect(projectId).not.toBe('existing');

    const project = await db.doc(`projects/${projectId}`).get();
    expect(project.get('name')).toBe('Tower B');
    expect(project.get('createdBy')).toBe(admin.uid);
    expect(project.get('createdAt')).toBeInstanceOf(Timestamp);

    const member = await db.doc(`projects/${projectId}/members/${admin.uid}`).get();
    expect(member.data()).toMatchObject({ uid: admin.uid, role: 'admin', status: 'active' });
    expect(member.get('joinedAt')).toBeInstanceOf(Timestamp);
  });

  it('a creator is discoverable through the collection-group query (index shape)', async () => {
    const admin = await user('cp-admin2@example.com');
    await seedMember('existing', admin.uid, 'admin');
    await callCallable('createProject', admin.token, { name: 'Second' });
    const mine = await db
      .collectionGroup('members')
      .where('uid', '==', admin.uid)
      .where('status', '==', 'active')
      .get();
    expect(mine.size).toBe(2);
  });

  it('denies members-only, non-members, removed admins, unauthenticated callers and bad names', async () => {
    const member = await user('cp-member@example.com');
    await seedMember('p', member.uid, 'member');
    expect((await callCallable('createProject', member.token, { name: 'X' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );

    const stranger = await user('cp-stranger@example.com');
    expect((await callCallable('createProject', stranger.token, { name: 'X' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );

    const gone = await user('cp-gone@example.com');
    await seedMember('q', gone.uid, 'admin', 'removed');
    expect((await callCallable('createProject', gone.token, { name: 'X' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );

    // A forged claim does not make an admin.
    const forged = await user('cp-forged@example.com', { id: 'p', role: 'admin' });
    expect((await callCallable('createProject', forged.token, { name: 'X' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );

    expect((await callCallable('createProject', null, { name: 'X' })).body.error?.status).toBe(
      'UNAUTHENTICATED'
    );

    const admin = await user('cp-admin3@example.com');
    await seedMember('r', admin.uid, 'admin');
    expect((await callCallable('createProject', admin.token, { name: '   ' })).body.error?.status).toBe(
      'INVALID_ARGUMENT'
    );
    expect(
      (await callCallable('createProject', admin.token, { name: 'x'.repeat(81) })).body.error?.status
    ).toBe('INVALID_ARGUMENT');
    const all = await db.collection('projects').get();
    expect(all.size).toBe(3); // only the three seeded projects
  });
});

describe('setActiveProject', () => {
  it('moves the claim to a project the caller is an active member of', async () => {
    const u = await user('sap@example.com', { id: 'pa', role: 'member' });
    await seedMember('pa', u.uid, 'member');
    await seedMember('pb', u.uid, 'admin');

    const res = await callCallable('setActiveProject', u.token, { projectId: 'pb' });
    expect(res.body.result).toMatchObject({ projectId: 'pb', role: 'admin' });
    const record = await auth.getUser(u.uid);
    expect(record.customClaims).toEqual({ currentProject: { id: 'pb', role: 'admin' } });
  });

  it('denies a non-member, a removed member and a missing projectId', async () => {
    const u = await user('sap2@example.com');
    await seedMember('pa', 'someone-else', 'admin');
    expect((await callCallable('setActiveProject', u.token, { projectId: 'pa' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );
    await seedMember('pr', u.uid, 'member', 'removed');
    expect((await callCallable('setActiveProject', u.token, { projectId: 'pr' })).body.error?.status).toBe(
      'PERMISSION_DENIED'
    );
    expect((await callCallable('setActiveProject', u.token, {})).body.error?.status).toBe(
      'INVALID_ARGUMENT'
    );
    expect((await auth.getUser(u.uid)).customClaims ?? {}).toEqual({});
  });
});

describe('admin callables in a multi-project world', () => {
  it('inviteMember acts on the NAMED project (membership doc, not the claim)', async () => {
    // Claim says pa, but the user is admin in pa AND pb.
    const admin = await user('multi-admin@example.com', { id: 'pa', role: 'admin' });
    await seedMember('pa', admin.uid, 'admin');
    await seedMember('pb', admin.uid, 'admin');
    const token = await signInForIdToken('multi-admin@example.com');

    const res = await callCallable('inviteMember', token, {
      email: 'new@example.com',
      role: 'member',
      projectId: 'pb',
    });
    expect(res.body.result?.invitationId).toBeTruthy();
    const inPb = await db.collection('projects/pb/invitations').get();
    const inPa = await db.collection('projects/pa/invitations').get();
    expect(inPb.size).toBe(1);
    expect(inPa.size).toBe(0);
  });

  it('denies naming a project where the caller is only a member, or not a member at all', async () => {
    const u = await user('multi-mixed@example.com', { id: 'pa', role: 'admin' });
    await seedMember('pa', u.uid, 'admin');
    await seedMember('pb', u.uid, 'member');
    await seedMember('pc', 'someone', 'admin');
    const token = await signInForIdToken('multi-mixed@example.com');
    for (const projectId of ['pb', 'pc']) {
      const res = await callCallable('inviteMember', token, {
        email: 'x@example.com',
        role: 'member',
        projectId,
      });
      expect(res.body.error?.status).toBe('PERMISSION_DENIED');
    }
  });

  it('a stale admin claim does not authorize once the member doc says member', async () => {
    const u = await user('stale@example.com', { id: 'pa', role: 'admin' });
    await seedMember('pa', u.uid, 'member');
    const token = await signInForIdToken('stale@example.com');
    const res = await callCallable('inviteMember', token, { email: 'y@example.com', role: 'member' });
    expect(res.body.error?.status).toBe('PERMISSION_DENIED');
  });

  it('setMemberRole / removeMember leave a target claim for ANOTHER project alone', async () => {
    const admin = await user('claim-admin@example.com', { id: 'pa', role: 'admin' });
    await seedMember('pa', admin.uid, 'admin');
    const target = await user('claim-target@example.com', { id: 'pz', role: 'member' });
    await seedMember('pa', target.uid, 'member');
    const token = await signInForIdToken('claim-admin@example.com');

    const set = await callCallable('setMemberRole', token, { uid: target.uid, role: 'admin' });
    expect(set.body.result).toBeTruthy();
    const afterSet = await db.doc(`projects/pa/members/${target.uid}`).get();
    expect(afterSet.get('uid')).toBe(target.uid);
    expect(afterSet.get('role')).toBe('admin');
    expect((await auth.getUser(target.uid)).customClaims).toEqual({
      currentProject: { id: 'pz', role: 'member' },
    });

    const rem = await callCallable('removeMember', token, { uid: target.uid });
    expect(rem.body.result).toBeTruthy();
    expect((await auth.getUser(target.uid)).customClaims).toEqual({
      currentProject: { id: 'pz', role: 'member' },
    });
  });

  it('setMemberRole / removeMember DO rewrite / clear the claim when it names this project', async () => {
    const admin = await user('claim-admin2@example.com', { id: 'pa', role: 'admin' });
    await seedMember('pa', admin.uid, 'admin');
    const target = await user('claim-target2@example.com', { id: 'pa', role: 'member' });
    await seedMember('pa', target.uid, 'member');
    const token = await signInForIdToken('claim-admin2@example.com');

    await callCallable('setMemberRole', token, { uid: target.uid, role: 'admin' });
    expect((await auth.getUser(target.uid)).customClaims).toEqual({
      currentProject: { id: 'pa', role: 'admin' },
    });
    await callCallable('removeMember', token, { uid: target.uid });
    expect((await auth.getUser(target.uid)).customClaims ?? {}).toEqual({});
  });
});

describe('redeemInvitation writes the Phase 1b member shape', () => {
  it('member doc has uid and a server Timestamp joinedAt', async () => {
    const owner = await user('rd-owner@example.com');
    await seedMember('pa', owner.uid, 'admin');
    const invitee = await user('rd-invitee@example.com');
    const inv = await db.collection('projects/pa/invitations').add({
      email: 'rd-invitee@example.com',
      role: 'member',
      invitedBy: owner.uid,
      invitedAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      status: 'pending',
    });
    const res = await callCallable('redeemInvitation', invitee.token, { inviteId: inv.id });
    expect(res.body.result?.status).toBe('accepted');
    const member = await db.doc(`projects/pa/members/${invitee.uid}`).get();
    expect(member.get('uid')).toBe(invitee.uid);
    expect(member.get('joinedAt')).toBeInstanceOf(Timestamp);
  });
});
