// Mirrors apps/settings/__tests__/setup.ts pattern:
// - fake-indexeddb/auto for Dexie in tests
// - Node Blob/File polyfills for jsdom
// - jest-dom matchers for vitest

import 'fake-indexeddb/auto';
import { Blob, File } from 'node:buffer';

if (typeof globalThis.Blob === 'undefined') {
  (globalThis as unknown as { Blob: typeof Blob }).Blob = Blob;
}
if (typeof globalThis.File === 'undefined') {
  (globalThis as unknown as { File: typeof File }).File = File;
}

import '@testing-library/jest-dom/vitest';