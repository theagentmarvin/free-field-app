/**
 * seed.mjs — Wave-1B tasks live-e2e seeding (uncommitted).
 *
 * Seeds the Firebase Auth + Firestore EMULATORS via the Admin SDK so the
 * drive.mjs headless browser harness can exercise the REAL (non-demo) path:
 *   - three auth users (member A, member B, admin) with the locked custom
 *     claim shape { currentProject: { id, role } },
 *   - the project doc + member docs + a task counter (next=0 so the first
 *     create allocates num=1 and the rules validate the 0→1 increment),
 *   - one sign-in link per member (admin generates links against the Auth
 *     emulator; drive.mjs navigates each browser context through it).
 *
 * Does NOT touch product files. Writes scripts/e2e/seed-output.json for
 * drive.mjs. Run AFTER `firebase emulators:start` (auth:9099, firestore:8080).
 */

const EMAILS = {
  A: 'member-a@freefield.test',
  B: 'member-b@freefield.test',
  admin: 'admin@freefield.test',
};

const PID = 'default-project'; // seeded project id (matches app default + functions)
const FIREBASE_PROJECT = 'free-field-dev'; // emulator single-project (from .firebaserc)
const CONTINUE_URL = 'http://localhost:5174/finish-sign-in';

process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.FIREBASE_STORAGE_EMULATOR_HOST = 'localhost:9199';
process.env.GCLOUD_PROJECT = FIREBASE_PROJECT;

const { initializeApp, getApps } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');
const { getFirestore } = await import('firebase-admin/firestore');

if (getApps().length === 0) initializeApp({ projectId: FIREBASE_PROJECT });
const auth = getAuth();
const db = getFirestore();

const now = Date.now();

/** Get-or-create an auth user, wipe claims, verify email. Returns uid. */
async function ensureUser(role) {
  const email = EMAILS[role];
  let uid;
  try {
    const u = await auth.getUserByEmail(email);
    uid = u.uid;
    await auth.updateUser(uid, { email, emailVerified: true });
  } catch {
    const u = await auth.createUser({ email, emailVerified: true });
    uid = u.uid;
  }
  await auth.setCustomUserClaims(uid, { currentProject: { id: PID, role } });
  return uid;
}

// 1. Users + claims (member A, member B, admin).
const uids = {};
const links = {};
for (const role of ['A', 'B', 'admin']) {
  uids[role] = await ensureUser(role === 'admin' ? 'admin' : 'member');
  console.log(`✓ auth user ${role}: ${EMAILS[role]} (${uids[role]}) role=${role === 'admin' ? 'admin' : 'member'}`);
}

// 2. Sign-in links (member A + B only; admin not driven headless).
for (const role of ['A', 'B']) {
  const link = await auth.generateSignInWithEmailLink(EMAILS[role], {
    url: CONTINUE_URL,
  });
  links[role] = link;
  console.log(`✓ sign-in link ${role}: ${link.slice(0, 80)}…`);
}

// 3. Firestore docs (Admin SDK bypasses rules).
// Project doc.
await db.doc(`projects/${PID}`).set({
  name: 'E2E Project',
  ownerUid: uids.admin,
  createdAt: now,
  memberCount: 3,
});
console.log(`✓ project doc projects/${PID}`);

// Member docs.
const roleMap = { A: 'member', B: 'member', admin: 'admin' };
for (const role of ['A', 'B', 'admin']) {
  await db.doc(`projects/${PID}/members/${uids[role]}`).set({
    role: roleMap[role],
    joinedAt: now,
    invitedBy: 'e2e-seed',
    status: 'active',
  });
  console.log(`✓ member projects/${PID}/members/${role} (${roleMap[role]})`);
}

// User profile docs (displayName so the compose assignee picker + actor show names).
const names = { A: 'Member A', B: 'Member B', admin: 'Admin' };
for (const role of ['A', 'B', 'admin']) {
  await db.doc(`users/${uids[role]}`).set(
    { uid: uids[role], email: EMAILS[role], displayName: names[role], createdAt: now },
    { merge: true },
  );
}

// Task counter: next=0 → the FIRST client create allocates num=1 inside the
// rules-pinned transaction (create writes next==1, each later +1).
await db.doc(`projects/${PID}/taskCounters/tasks`).set({ next: 0 });
console.log(`✓ task counter projects/${PID}/taskCounters/tasks {next:0}`);

// 4. Emit the seed manifest for drive.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const out = {
  generatedAt: new Date().toISOString(),
  firebaseProject: FIREBASE_PROJECT,
  pid: PID,
  continueUrl: CONTINUE_URL,
  users: {
    A: { uid: uids.A, email: EMAILS.A, role: 'member', displayName: names.A, link: links.A },
    B: { uid: uids.B, email: EMAILS.B, role: 'member', displayName: names.B, link: links.B },
    admin: { uid: uids.admin, email: EMAILS.admin, role: 'admin', displayName: names.admin },
  },
};
writeFileSync(join(here, 'seed-output.json'), JSON.stringify(out, null, 2));
console.log('\n✓ seed-output.json written. Manifest:');
console.log(JSON.stringify(out, null, 2));