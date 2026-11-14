import { createRoot } from "react-dom/client";

// PHASE 3 placeholder. The Capacitor shell will:
//   1. Add @capacitor/core + @capacitor/android
//   2. Fill in capacitor.config.ts with appId: "cl.freefield.app"
//   3. Run `npx cap add android` to scaffold the native wrapper
//   4. Mount the same <SettingsView/>, <ModelsView/>, <DocsView/> imported
//      from shared packages — apps/hybrid is the only app that ships to
//      web/PWA/Android in production. settings/models/docs are web-only
//      dev surfaces for fast iteration.
const root = createRoot(document.getElementById("root")!);
root.render(
  <div
    style={{
      padding: 24,
      fontFamily: "system-ui",
      color: "#1f2329",
      background: "#f2f3f4",
      minHeight: "100vh",
    }}
  >
    <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>FreeField Hybrid Shell</h1>
    <p style={{ marginTop: 8, color: "#6b7280" }}>
      Phase 3 will wire Capacitor + Android. Until then this placeholder confirms
      the bootable shape of <code>apps/hybrid/</code>.
    </p>
  </div>,
);
