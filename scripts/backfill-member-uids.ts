#!/usr/bin/env node
/**
 * backfill-member-uids.ts — one-off Phase 1b migration (docs/SPEC-PHASE-1.md §2.1).
 *
 * For every /projects/{pid}/members/{uid} doc:
 *   - add `uid` (= the doc id) when missing or wrong, and
 *   - convert a numeric (epoch-millis) `joinedAt` to a Firestore Timestamp.
 * Idempotent: docs that are already correct are not written. Uses the
 * Admin SDK (bypasses rules), so run it by hand with deployer credentials.
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   npx tsx scripts/backfill-member-uids.ts <firebase-project> [--dry-run]
 *
 * Against the emulator: set FIRESTORE_EMULATOR_HOST=localhost:8080 first.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';

async function main() {
  const firebaseProject = process.argv[2] || process.env.FIREBASE_PROJECT_ID;
  const dryRun = process.argv.includes('--dry-run');
  if (!firebaseProject) {
    console.error('Usage: npx tsx scripts/backfill-member-uids.ts <firebase-project> [--dry-run]');
    process.exit(1);
  }

  if (getApps().length === 0) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS ? require(process.env.GOOGLE_APPLICATION_CREDENTIALS) : null;
    if (creds?.type === 'service_account') {
      initializeApp({ credential: cert(creds), projectId: firebaseProject });
    } else {
      // No key, or an `authorized_user` file (e.g. the Firebase CLI login):
      // application default credentials read GOOGLE_APPLICATION_CREDENTIALS themselves.
      initializeApp({ projectId: firebaseProject });
    }
  }
  const db = getFirestore();

  const snap = await db.collectionGroup('members').get();
  let scanned = 0;
  let updated = 0;
  let batch = db.batch();
  let pending = 0;

  for (const d of snap.docs) {
    // Only /projects/{pid}/members/{uid} (guards against other `members` collections).
    if (d.ref.parent.parent?.parent.id !== 'projects') continue;
    scanned += 1;
    const patch: Record<string, unknown> = {};
    if (d.get('uid') !== d.id) patch.uid = d.id;
    const joinedAt = d.get('joinedAt');
    if (typeof joinedAt === 'number') patch.joinedAt = Timestamp.fromMillis(joinedAt);
    if (Object.keys(patch).length === 0) continue;

    updated += 1;
    console.log(`${dryRun ? '[dry-run] ' : ''}${d.ref.path}: ${Object.keys(patch).join(', ')}`);
    if (dryRun) continue;
    batch.set(d.ref, patch, { merge: true });
    pending += 1;
    if (pending === 400) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }
  if (pending > 0) await batch.commit();

  console.log(`Scanned ${scanned} member docs; ${dryRun ? 'would update' : 'updated'} ${updated}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
