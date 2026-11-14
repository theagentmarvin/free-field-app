import { defineConfig } from 'vitest/config';

// The hook / guard tests render React; demo.test.ts opts back into
// the node environment with a `@vitest-environment node` docblock.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
  },
});
