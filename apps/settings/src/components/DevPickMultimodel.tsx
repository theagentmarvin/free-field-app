// src/components/DevPickMultimodel.tsx
//
// Wave 19 — DEV-gated multi-model picking harness.
//
// Mounts the real <IfcViewer> and loads BOTH bundled sample IFCs
// (`sample.ifc` STRUCTURAL + `MECHANICAL.ifc` MEP fixture) into the
// SAME building so a click on the SECOND model exercises the exact
// bug path the field report described: "with two models loaded,
// element clicks work on the first model only".
//
// Every `setOnElementPick` event is logged to the console AND to an
// on-screen overlay so the evidence is visible in one screenshot.
//
// This route is intentionally NOT wired into production navigation:
// it is only reachable at `/dev/pick-multimodel` when Vite runs in
// dev mode (see the `import.meta.env.DEV` gate in MainShell). It is a
// throwaway dev bench, not a shipped surface.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import {
  IfcViewer,
  type IfcViewerHandle,
} from "@ff/viewer-react";
import { getFragBlob } from "@ff/data/db/tables/fragBlobs";
import {
  useIfcFiles,
  useIfcPipeline,
  getStoreysForBuilding,
} from "@ff/data/hooks";
import {
  createBuilding,
  findBuildingByName,
} from "@ff/data/db/tables/buildings";

import { DEMO_PROJECT_ID } from "@ff/auth";

/** The two models to federate into one building for the pick test. */
const SAMPLES: Array<{ url: string; name: string }> = [
  { url: "/samples/sample.ifc", name: "sample.ifc" },
  { url: "/samples/MECHANICAL.ifc", name: "MECHANICAL.ifc" },
];

const HARNESS_BUILDING_NAME = "Pick MultiModel (dev)";

const rootStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  background: "#0e1116",
  display: "flex",
  flexDirection: "column",
};

const headerStyle: CSSProperties = {
  padding: "6px 10px",
  color: "#c9d1d9",
  fontFamily: "var(--ff-mono, monospace)",
  fontSize: 12,
  borderBottom: "1px solid #30363d",
};

const logStyle: CSSProperties = {
  position: "absolute",
  top: 44,
  left: 10,
  right: 10,
  maxHeight: "45%",
  overflow: "auto",
  background: "rgba(10,12,16,0.92)",
  color: "#7ee787",
  fontFamily: "var(--ff-mono, monospace)",
  fontSize: 11,
  padding: 8,
  borderRadius: 6,
  pointerEvents: "none",
  zIndex: 20,
  whiteSpace: "pre-wrap",
};

const fillerStyle: CSSProperties = {
  color: "#8b949e",
  padding: 16,
  fontFamily: "var(--ff-mono, monospace)",
};

export default function DevPickMultimodel(): ReactNode {
  const { loadIfc, registerFragments } = useIfcPipeline();
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const viewerRef = useRef<IfcViewerHandle | null>(null);
  const files = useIfcFiles(buildingId);

  // Find-or-create the harness building under the demo project so the
  // samples land somewhere the IfcViewer live query can see them. The
  // retry loop absorbs the transient races (StrictMode double-mount +
  // the demo seed's first Dexie schema-open) that can make the first
  // `listBuildings` / `createBuilding` throw.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 30 && !cancelled; attempt += 1) {
        try {
          const existing = await findBuildingByName(
            DEMO_PROJECT_ID,
            HARNESS_BUILDING_NAME,
          );
          const building =
            existing ??
            (await createBuilding({
              projectId: DEMO_PROJECT_ID,
              name: HARNESS_BUILDING_NAME,
              metadata: {},
            }));
          if (!cancelled) setBuildingId(building.id);
          return;
        } catch (err) {
          // Transient (schema open / duplicate from StrictMode). Back
          // off and retry; the next `findBuildingByName` sees the row.
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (!cancelled) {
        setLog((prev) => ["building setup failed after retries", ...prev].slice(0, 12));
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[dev/pick-multimodel] building setup failed", err);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load both samples through the SAME pipeline UploadButton uses.
  const loadStartedRef = useRef(false);
  useEffect(() => {
    if (!buildingId || loadStartedRef.current) return;
    loadStartedRef.current = true;
    (async () => {
      for (const sample of SAMPLES) {
        const res = await fetch(encodeURI(sample.url));
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(
            `[dev/pick-multimodel] ${sample.url} HTTP ${res.status}`,
          );
          continue;
        }
        const blob = await res.blob();
        await loadIfc(new File([blob], sample.name), buildingId);
      }
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[dev/pick-multimodel] sample load failed", err);
    });
  }, [buildingId, loadIfc]);

  // Subscribe to the pick pipeline once the imperative handle appears.
  // Same rAF-poll pattern PropertiesDrawer uses (the handle may land a
  // tick after the component mounts).
  useEffect(() => {
    let cancelled = false;
    let installed: IfcViewerHandle | null = null;
    let raf: number | null = null;
    function trySubscribe(): void {
      if (cancelled) return;
      const handle = viewerRef.current;
      if (!handle) {
        raf = requestAnimationFrame(trySubscribe);
        return;
      }
      installed = handle;
      // Wave 19 takeover: expose the handle for scripted verification
      // (DEV-only route; used by the on-device proof harness).
      (window as unknown as { __ffPickHandle?: IfcViewerHandle }).__ffPickHandle =
        handle;
      handle.setOnElementPick((e) => {
        const line =
          e === null
            ? "clear (empty space)"
            : `modelId=${e.modelId} expressId=${e.expressId} point=${e.point.x.toFixed(2)},${e.point.y.toFixed(2)},${e.point.z.toFixed(2)}`;
        // eslint-disable-next-line no-console
        console.info(`[dev/pick-multimodel] ElementPickEvent: ${line}`);
        setLog((prev) => [line, ...prev].slice(0, 12));
      });
    }
    trySubscribe();
    return () => {
      cancelled = true;
      if (raf !== null) cancelAnimationFrame(raf);
      if (installed) installed.setOnElementPick(null);
    };
  }, []);

  // Stable no-op viewer slice — the harness doesn't drive storeys.
  const viewerSlice = useMemo(
    () => ({
      activeStoreyName: null as string | null,
      setActiveStoreyName: (): void => undefined,
    }),
    [],
  );

  return (
    <div style={rootStyle} data-testid="dev-pick-multimodel">
      <div style={headerStyle}>
        dev/pick-multimodel — click elements on BOTH models (sample.ifc +
        MECHANICAL.ifc); pick events log below &amp; to console.
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        {buildingId ? (
          <IfcViewer
            ref={viewerRef}
            projectId={DEMO_PROJECT_ID}
            activeBuildingId={buildingId}
            files={files}
            getFragBlob={getFragBlob}
            registerFragments={registerFragments}
            getStoreysForBuilding={getStoreysForBuilding}
            viewerSlice={viewerSlice}
          />
        ) : (
          <div style={fillerStyle}>creating harness building…</div>
        )}
      </div>
      <div style={logStyle}>
        {log.length === 0 ? "no picks yet" : log.join("\n")}
      </div>
    </div>
  );
}