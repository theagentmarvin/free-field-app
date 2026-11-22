// packages/ff-viewer-react/e2e-harness/main.tsx
//
// Minimal page that mounts the real <IfcViewer> with one .frag (served from
// /__frag/<key>) and exposes `window.__e2e` for the Playwright check
// (check.mjs). URL params:
//   m=<key.frag>   model to load (default sample.frag)
//   pr=<n>         renderer pixel ratio applied once the model is loaded
//                  (what a WebView host does with `renderer.three.setPixelRatio`)
//   strict=1       wrap in React.StrictMode
//   fit=1          pass fitOnFirstLoad
/* eslint-disable @typescript-eslint/no-explicit-any */
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IfcViewer } from "../src";
import * as OBC from "@thatopen/components";
// Harness-only: the engine's raycast needs a real Vector2 for `mouse`.
// eslint-disable-next-line no-restricted-imports
import { Vector2 } from "three";
import type {
  ElementPickEvent,
  IfcFileListItem,
  IfcViewerHandle,
} from "../src";

const params = new URLSearchParams(location.search);
const key = params.get("m") ?? "sample.frag";
const BUILDING_ID = "e2e-building";
const files: IfcFileListItem[] = [
  {
    file: { id: key.replace(/\.frag$/, ""), name: key, buildingId: BUILDING_ID },
    latestVersion: { id: `${key}-v1`, fragBlobKey: key, versionNumber: 1 },
  },
];

// `nofast=1`: make the GPU id-pass picker fail to construct, which is what
// drives the viewer onto the Highlighter (raycaster) backend.
if (params.get("nofast") === "1") {
  (OBC.FastModelPickers.prototype as any).get = () => {
    throw new Error("e2e: FastModelPicker disabled");
  };
}

interface E2E {
  handle: IfcViewerHandle | null;
  picks: Array<ElementPickEvent | null>;
  errors: string[];
  ready: boolean;
  readyInfo: unknown;
  fragments: OBC.FragmentsManager | null;
  unmount: () => void;
  mount: () => void;
}
const eventLog: string[] = [];
for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "click", "touchstart", "touchend"]) {
  window.addEventListener(
    t,
    (e) => {
      const x = e as PointerEvent;
      eventLog.push(`${Math.round(performance.now())} ${t} ${x.pointerType ?? ""} ${Math.round(x.clientX ?? 0)},${Math.round(x.clientY ?? 0)}`);
    },
    { capture: true, passive: true },
  );
}
(window as any).__e2eEvents = eventLog;

const e2e: E2E = {
  handle: null,
  picks: [],
  errors: [],
  ready: false,
  readyInfo: null,
  fragments: null,
  unmount: () => undefined,
  mount: () => undefined,
};
(window as unknown as { __e2e: E2E }).__e2e = e2e;
window.addEventListener("error", (e) => e2e.errors.push(String(e.message)));
window.addEventListener("unhandledrejection", (e) =>
  e2e.errors.push("rejection: " + String((e.reason as Error)?.message ?? e.reason)),
);

function registerFragments(f: OBC.FragmentsManager | null): void {
  if (f) e2e.fragments = f;
}
function getWorld(): any {
  const comps = (e2e.fragments as any)?.components as OBC.Components | undefined;
  if (!comps) return null;
  for (const w of comps.get(OBC.Worlds).list.values()) return w;
  return null;
}
(e2e as any).getWorld = getWorld;
(e2e as any).setPixelRatio = (r: number) => {
  const w = getWorld();
  w.renderer.three.setPixelRatio(r);
  w.renderer.resize?.();
};

/** Screen points (CSS px) where the worker raycast hits the model. */
(e2e as any).scanHits = async (): Promise<Array<{ x: number; y: number; id: number }>> => {
  const w = getWorld();
  const canvas = w.renderer.three.domElement as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const out: Array<{ x: number; y: number; id: number }> = [];
  for (let gy = 0.1; gy <= 0.9; gy += 0.08) {
    for (let gx = 0.1; gx <= 0.9; gx += 0.08) {
      const x = rect.left + rect.width * gx;
      const y = rect.top + rect.height * gy;
      const r = await (e2e.fragments as any).raycast({
        camera: w.camera.three,
        dom: canvas,
        mouse: new Vector2(x, y),
      });
      if (r && typeof r.localId === "number") out.push({ x, y, id: r.localId });
    }
  }
  return out;
};

async function getFragBlob(k: string): Promise<Blob | null> {
  const res = await fetch(`/__frag/${k}`);
  return res.ok ? res.blob() : null;
}
const viewerSlice = { activeStoreyName: null as string | null, setActiveStoreyName: () => {} };

function Harness(): JSX.Element {
  const ref = useRef<IfcViewerHandle | null>(null);
  const [shown, setShown] = useState(true);
  useEffect(() => {
    e2e.unmount = () => setShown(false);
    e2e.mount = () => setShown(true);
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      {shown && (
        <IfcViewer
          ref={(h) => {
            ref.current = h;
            e2e.handle = h;
            if (h) h.setOnElementPick((e) => e2e.picks.push(e));
          }}
          projectId="e2e"
          activeBuildingId={BUILDING_ID}
          files={files}
          getFragBlob={getFragBlob}
          registerFragments={registerFragments}
          viewerSlice={viewerSlice}
          onReady={(ctx: unknown) => {
            e2e.readyInfo = ctx;
            e2e.ready = true;
          }}
          fitOnFirstLoad={params.get("fit") === "1"}
        />
      )}
    </div>
  );
}

const root: Root = createRoot(document.getElementById("root")!);
root.render(params.get("strict") === "1" ? <StrictMode><Harness /></StrictMode> : <Harness />);
