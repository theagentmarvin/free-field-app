// Wave 18 U7 (spec §6): app-shell telemetry init — fire-and-forget,
// never awaited by first paint; inert local-only path without a DSN.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bootTelemetry } from "./telemetryBoot";
import MainShell from "@shell/MainShell";
import { redirectEntryToModels } from "@shell/entryRoute";
import { installStaleChunkReload } from "@shell/staleChunkReload";
import "./styles/global.css";
// PdfOverlay (and the toolbar it wraps) live in @ff/viewer-react.
// After Phase-1-lite extraction the package no longer auto-imports
// its own CSS — the consumer entry point must do it explicitly.
// Without this, the PDF viewer renders without styles and the
// toolbar/zoom controls are invisible. (Fix #4 from the
// post-Phase-1-lite audit.)
//
// Vite's import-analysis plugin can't resolve CSS via a package
// exports subpath (`@ff/viewer/src/pdf/pdfViewer.css` fails). We
// use a relative path from apps/settings/src → workspace root →
// the file. This is the only piece of cross-package resolution
// in Settings that uses a relative path; everything else goes
// through `@ff/*` package imports or `@core/*` aliases.
import "../../../packages/ff-viewer/src/pdf/pdfViewer.css";

bootTelemetry();

// Every fresh load of the app root opens in Models (see entryRoute.ts).
redirectEntryToModels();

// A deploy while this tab was open: reload once instead of failing the
// lazy module load (see staleChunkReload.ts).
installStaleChunkReload();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container #root not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <MainShell />
  </StrictMode>,
);
