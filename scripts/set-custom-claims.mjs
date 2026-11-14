/**
 * Sets custom claims on a user in the Auth emulator.
 * Workaround for admin.auth().setCustomUserClaims() not propagating in the
 * functions emulator.
 *
 * Usage: node scripts/set-custom-claims.mjs
 */

// The Admin SDK uses FIREBASE_AUTH_EMULATOR_HOST to connect to the emulator.
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

// Use a dummy service account for emulator (the emulator doesn't validate it).
if (getApps().length === 0) {
  initializeApp({
    projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID,
  });
}

const auth = getAuth();

const uid = process.env.TARGET_UID;
if (!uid) throw new Error('Set TARGET_UID to the Firebase Auth uid to inspect/update.');

const claims = {
  currentProject: { id: 'default-project', role: 'admin' },
};

try {
  await auth.setCustomUserClaims(uid, claims);
  console.log('✅ Custom claims set for', uid);
  console.log('   claims:', JSON.stringify(claims));
} catch (err) {
  console.error('❌ Failed:', err.message);
}
