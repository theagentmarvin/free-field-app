// Vite dev-server launcher for Settings app.
// tsx handles TypeScript natively — avoids the .bin/ shell-script wrapper
// which fails on Windows.

import { createServer } from "vite";

async function main() {
  const server = await createServer({ configFile: "./vite.config.ts" });
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}

main();