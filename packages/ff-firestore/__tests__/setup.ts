// Mirrors apps/settings/__tests__/setup.ts pattern for the rules tests.
// @firebase/rules-unit-testing doesn't need fake-indexeddb (it uses an
// in-memory Firestore emulator), but we set up the env consistently
// with the rest of the workspace so vitest globals + matchers are
// available.

import '@testing-library/jest-dom/vitest';