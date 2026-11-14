/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// apps/users is consumed at runtime by apps/settings via the
// @free-field/users workspace dep. No own dev server.
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  resolve: {
    alias: {
      '@ff/auth': new URL('../../packages/ff-auth/src', import.meta.url).pathname,
      '@ff/firestore': new URL('../../packages/ff-firestore/src', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
  },
});