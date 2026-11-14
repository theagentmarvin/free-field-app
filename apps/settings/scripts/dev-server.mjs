// Launcher: imports tsx/esm then calls Vite's JS entry point.
// Avoids the .bin shell-script wrapper which fails on Windows.
await import('tsx/esm');
const { createServer } = await import('vite');
const server = await createServer({ configFile: './vite.config.ts' });
await server.listen();
server.printUrls();
server.bindCLIShortcuts({ print: true });