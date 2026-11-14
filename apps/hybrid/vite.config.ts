import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// PHASE 3 will extend this with:
//   - capacitor.config.ts at apps/hybrid/ (appId, webDir, plugin config)
//   - @capacitor/core + @capacitor/android as devDependencies
//   - `npx cap add android` to scaffold apps/hybrid/android/
export default defineConfig({
  plugins: [react()],
  server: { port: 5175 },
  build: { outDir: "dist" },
});
