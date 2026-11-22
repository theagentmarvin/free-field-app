// Ambient type declarations for Vite-style env vars consumed by apps/users.
// Mirrors the same keys @ff/auth declares — keep in sync.

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_FIREBASE_USE_EMULATOR?: string;
  /** Emulator host override (default 'localhost'). */
  readonly VITE_FIREBASE_EMULATOR_HOST?: string;
  readonly VITE_EXPECTED_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_FUNCTIONS_REGION?: string;
  // Demo mode (plan v4 amendment v4.1): mocked sign-in, no Firebase.
  readonly VITE_FF_DEMO_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}