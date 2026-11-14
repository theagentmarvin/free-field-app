import { defineConfig } from 'vitest/config';

// @firebase/rules-unit-testing talks to a real Firestore emulator via Node.
// Other tests in this package (Zod schemas, refs, etc.) can run in jsdom.
// Per-file env directives (// @vitest-environment node) override this default.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    // Function integration tests run transactional callables against the
    // emulator; concurrency retries can take a few seconds.
    testTimeout: 30000,
    // Rules tests need the emulator running. Skip them when FIREBASE_EMULATOR_HUB
    // is not set so unit-only runs (CI lint, etc.) don't fail.
    include: ['__tests__/**/*.test.ts', 'functions/__tests__/**/*.test.ts'],
  },
});