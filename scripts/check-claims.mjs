import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

if (getApps().length === 0) {
  initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID });
}

const auth = getAuth();
const uid = process.env.TARGET_UID;
if (!uid) throw new Error('Set TARGET_UID to the Firebase Auth uid to inspect/update.');

try {
  const user = await auth.getUser(uid);
  console.log('customClaims:', JSON.stringify(user.customClaims));
  console.log('uid:', user.uid);
  
  // Re-set claims to be sure
  await auth.setCustomUserClaims(uid, {
    currentProject: { id: 'default-project', role: 'admin' },
  });
  console.log('✅ Claims re-set');
} catch(e) {
  console.error('ERROR:', e.message);
}
