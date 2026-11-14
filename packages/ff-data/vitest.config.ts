// packages/ff-data/vitest.config.ts — Node environment; IndexedDB comes
// from fake-indexeddb (loaded in the setup file before Dexie).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./__tests__/setup.ts"],
    // Real web-ifc conversions (convertIfc.test) are a few seconds each.
    testTimeout: 30000,
  },
});
