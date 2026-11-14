#!/usr/bin/env node
/**
 * bootstrap-admin.ts — Bootstrap the first admin via Firebase Admin SDK.
 *
 * Use this when you can't (or don't want to) deploy Cloud Functions yet,
 * or as a headless alternative to the UI bootstrap button.
 *
 * Uses the same three-state /meta/bootstrap.status protocol as the
 * Cloud Function: absent/'none' → 'pending' → 'complete'.
 *
 * Prerequisites:
 *   - A Firebase service account key with Editor/Owner role
 *   - The key file path in GOOGLE_APPLICATION_CREDENTIALS env var
 *     OR the Firebase project must be discoverable via ADC
 *
 * Usage:
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
 *   npx tsx scripts/bootstrap-admin.ts <email> [project-id] [firebase-project]
 *
 *   # Example:
 *   npx tsx scripts/bootstrap-admin.ts admin@acme.com default-project <your-firebase-project-id>
 *
 * If no Firebase project is given, falls back to FIREBASE_PROJECT_ID env var.
 *
 * Security: this script uses the Firebase Admin SDK with service-account
 * credentials. It writes to Firestore AND sets custom claims — privileges
 * no client-side code has. Keep the service account key secure.
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Transaction } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

type BootstrapStatus = 'none' | 'pending' | 'complete';

interface BootstrapMeta {
  status: BootstrapStatus;
  firstAdminEmail: string;
  firstAdminUid?: string;
  initiatedAt?: FirebaseFirestore.Timestamp;
  claimedAt?: FirebaseFirestore.Timestamp;
  completedAt?: FirebaseFirestore.Timestamp;
}

async function main() {
  const email = process.argv[2];
  const projectId = process.argv[3] || 'default-project';
  const firebaseProject = process.argv[4] || process.env.FIREBASE_PROJECT_ID;

  if (!email) {
    console.error('Usage: npx tsx scripts/bootstrap-admin.ts <email> [project-id] [firebase-project]');
    process.exit(1);
  }

  if (!firebaseProject) {
    console.error('No Firebase project specified. Set FIREBASE_PROJECT_ID or pass as 3rd argument.');
    process.exit(1);
  }

  console.log(`Bootstrapping admin for project "${firebaseProject}"...`);

  // Initialize Admin SDK.
  let app;
  if (getApps().length === 0) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const sa = require(process.env.GOOGLE_APPLICATION_CREDENTIALS);
      app = initializeApp({ credential: cert(sa), projectId: firebaseProject });
    } else {
      app = initializeApp({ projectId: firebaseProject });
    }
  } else {
    app = getApps()[0];
  }

  const db = getFirestore(app);
  const auth = getAuth(app);
  const metaRef = db.doc('meta/bootstrap');

  // Look up the user by email.
  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
  } catch {
    console.error(`❌ No Firebase Auth user found for email: ${email}`);
    console.error('   The user must sign in at least once before bootstrapping.');
    console.error('   Or use the Cloud Function email-link mode with a bootstrap secret.');
    process.exit(1);
  }

  const uid = userRecord.uid;

  // --- Atomic claim via transaction (same protocol as Cloud Function) ---
  await db.runTransaction(async (tx: Transaction) => {
    const meta = await tx.get(metaRef);
    const metaData = meta.data() as BootstrapMeta | undefined;

    if (metaData?.status === 'complete') {
      console.error('❌ Bootstrap already completed for this Firebase project.');
      process.exit(1);
    }

    if (metaData?.status === 'pending' && metaData.firstAdminEmail !== email) {
      console.error(`❌ Bootstrap is pending for ${metaData.firstAdminEmail}. Only that user can complete it.`);
      process.exit(1);
    }

    tx.set(metaRef, {
      status: 'pending' as BootstrapStatus,
      firstAdminEmail: email,
      firstAdminUid: uid,
      initiatedAt: metaData?.initiatedAt || FieldValue.serverTimestamp(),
      claimedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  // Idempotent side effects.
  await db.doc(`projects/${projectId}`).set({
    name: 'Default Project',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: uid,
  });

  await db.doc(`projects/${projectId}/members/${uid}`).set({
    uid,
    role: 'admin',
    joinedAt: FieldValue.serverTimestamp(),
    invitedBy: 'bootstrap',
    status: 'active',
  });

  await db.doc(`projects/${projectId}/roles/admin`).set({
    id: 'admin',
    name: 'Admin',
    isBuiltin: true,
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });

  await auth.setCustomUserClaims(uid, {
    currentProject: { id: projectId, role: 'admin' },
  });

  // Mark complete.
  await metaRef.set({
    status: 'complete' as BootstrapStatus,
    completedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  console.log(`✅ Bootstrap complete: uid=${uid}, email=${email}, project=${projectId}`);
  console.log('   The user must sign out and sign back in for claims to take effect.');
}

main().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
