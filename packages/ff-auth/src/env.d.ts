// Ambient type declarations for Vite-style env vars consumed by @ff/auth.
//
// Without this, AuthProvider and tenant-check can't reference
// import.meta.env in TypeScript without pulling `vite` in as a
// devDep (which we'd prefer to avoid — vite is the host's concern).
//
// This file is picked up automatically because tsconfig.json
// `include`s `src/**`. The augmentation is interface-level only —
// at runtime, import.meta.env is provided by Vite in apps/settings.
//
// For consistency with the build-time env names, keep this in
// sync with .env.example at repo root.

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
  // Demo mode (plan v4 amendment v4.1): "true" boots the app with the
  // mocked sign-in and zero Firebase backend.
  readonly VITE_FF_DEMO_AUTH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}