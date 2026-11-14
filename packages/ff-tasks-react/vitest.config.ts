import { defineConfig } from "vitest/config";

// Chunk 1 ships pure list logic only (no DOM render tests yet — the
// compose sheet chunk adds @testing-library when there is a store to
// exercise). tsc --noEmit covers the components' types either way.
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
  },
});
