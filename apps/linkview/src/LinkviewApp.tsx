// apps/linkview/src/LinkviewApp.tsx
//
// Wave 52 — entry for the `/linkview` route, reworked around the
// shared persistent 3D surface.
//
// The RIGHT pane is NOT a Linkview-owned viewer anymore: it portals
// the SAME <IfcViewer> surface the Models route uses (from the
// settings shell's <ViewerKeepAlive>) into its right pane, and layers
// the shared <PropertiesDrawer> on top. The LEFT pane keeps its own
// level-plan <IfcViewer> + <PdfOverlay> for the 2D plan (two
// simultaneous cameras → two instances).
//
// Wave 55 (Maintainer directive 2026-11-08 17:06 + 17:41 — canonical
// surface names in docs/ux/toolbar-nomenclature.md):
//   - The wave-52 <LinkviewSidebar> (persistent left panel) is GONE.
//     Its lists moved into the ONE floating panel slot
//     (<LinkviewNavPanel>), opened by the TOOLS toolbar
//     (<LinkviewNavToolbar>) at the top-left of the 3D pane.
//   - The Split View | Overlap mode toggle moved from the viewer
//     tools toolbar INTO the tools toolbar.
//   - Non-blank open (fixed): priority is first mapped PDF → first
//     extracted level → first model level, decided from the resolved
//     live queries (no resolution-order race), and a failed openLevel
//     (model still loading) is RETRIED on the left viewer's
//     onLoadedModelsChange instead of being dropped — that drop was
//     why the left 2D view "supposed to" auto-open but didn't.
//   - Overlap renders a single pane: the shared 3D surface with the
//     mapped PDF overlaid via <useFloorPlanOverlay> (reused machinery).

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import { useLiveQuery } from "dexie-react-hooks";

import {
  type IfcViewerHandle,
  type PdfOverlayHandle,
  type ViewerPose,
} from "@ff/viewer-react";
import { db } from "@ff/data/db/database";
import { useProjectId } from "@ff/auth";
import {
  attachPlanSnapshotThumb,
  setTaskLocationEnricher,
  TaskCalloutLayer2D,
} from "@ff/tasks-react";
import type { CalibrationRecord, StoreyRecord } from "@ff/types";

import {
  ViewerToolsProvider,
  useFloorPlanOverlay,
  useIsMobile,
  useModelsToolStore,
} from "@ff/viewer-tools";

import { linkviewDataSource } from "./linkviewDataSource";
import LinkviewNavToolbar, {
  type LinkviewPanelId,
} from "./LinkviewNavToolbar";
import LinkviewNavPanel from "./LinkviewNavPanel";
import LinkviewSplitCanvas from "./LinkviewSplitCanvas";
import LinkviewNavMarker from "./LinkviewNavMarker";
import {
  bearingFromPose,
  bearingTowardCentroid,
  clampPdfPoint,
  firstPersonPose,
  pdfBearingFromWorld,
  pitchFromPose,
  pdfFromWorldPoint,
  planDistance,
  seedPdfPoint,
  resolveStoreyFloorZ,
  shouldDeferForBaseShift,
  BASE_COORD_RETRY_MS,
  overlapTopDownPose,
  seedWorldPoint,
  shouldBackProjectCamera,
  worldFromPdfPoint,
  bearingChanged,
  CAMERA_SYNC_EPSILON,
  type PdfPoint,
} from "./linkviewNav";
import { useFirstPersonControls } from "./hooks/useFirstPersonControls";
import { queryExtractedStoreysForBuilding } from "./hooks/useExtractedStoreysForBuilding";
import { queryMappedPdfsForBuilding } from "./hooks/useMappedPdfsForBuilding";
import {
  loadLinkviewMode,
  persistLinkviewMode,
  type LinkviewMode,
} from "./linkviewMode";
import { useOverlayOpacityStore } from "./overlayOpacityStore";
import { linkviewLocationFromBim } from "./linkviewTaskLocation";
import { useLinkviewTaskOpen } from "./useLinkviewTaskOpen";

export interface LinkviewAppProps {
  /** The shared persistent surface handle (right pane). */
  viewerRef: RefObject<IfcViewerHandle>;
  /** Register the right pane as the shared surface's portal target. */
  registerHost: (node: HTMLElement | null) => void;
  /** True once the shared surface has loaded ≥1 model. */
  surfaceLoaded: boolean;
}

/**
 * Entry component for the `/linkview` route.
 */
export default function LinkviewApp({
  viewerRef,
  registerHost,
  surfaceLoaded,
}: LinkviewAppProps): ReactNode {
  return (
    <ViewerToolsProvider dataSource={linkviewDataSource}>
      <LinkviewAppInner
        viewerRef={viewerRef}
        registerHost={registerHost}
        surfaceLoaded={surfaceLoaded}
      />
    </ViewerToolsProvider>
  );
}

function LinkviewAppInner({
  viewerRef,
  registerHost,
  surfaceLoaded,
}: LinkviewAppProps): ReactNode {
  // Wave 52 — the active building now lives in the SHARED store (the
  // persistent surface reads it, too), so both modules follow the same
  // building.
  const projectId = useProjectId();
  const activeBuildingId = useModelsToolStore((s) => s.activeBuildingId);
  const setActiveBuildingId = useModelsToolStore(
    (s) => s.setActiveBuildingId,
  );
  const isMobile = useIsMobile();

  const [activePdfVersionId, setActivePdfVersionId] = useState<string | null>(
    null,
  );
  const [activeStoreyId, setActiveStoreyId] = useState<string | null>(null);

  // Wave 55 — the tools-toolbar panel tenant (null = closed).
  const [activePanel, setActivePanel] = useState<LinkviewPanelId | null>(
    null,
  );
  const handleTogglePanel = useCallback((id: LinkviewPanelId) => {
    setActivePanel((cur) => (cur === id ? null : id));
  }, []);
  const handleClosePanel = useCallback(() => setActivePanel(null), []);

  // Wave 52 — layout mode, persisted to localStorage. Wave 55 — the
  // toggle lives in the tools toolbar (LinkviewNavToolbar).
  const [mode, setMode] = useState<LinkviewMode>(() => loadLinkviewMode());
  const handleModeChange = useCallback((m: LinkviewMode) => {
    setMode(m);
    persistLinkviewMode(m);
  }, []);

  // Imperative ref to the LEFT level-plan IfcViewer.
  const leftViewerRef = useRef<IfcViewerHandle>(null);

  // Wave 57 — imperative handle to the LEFT <PdfOverlay> (the nav
  // marker portals into its annotation layer and reads its scale).
  const pdfOverlayRef = useRef<PdfOverlayHandle>(null);

  // Storey chooser for a PDF calibrated on several storeys: the user's
  // pick, scoped to the PDF version it was made on (a PDF switch drops
  // it without a reset effect).
  const [calStoreyChoice, setCalStoreyChoice] = useState<{
    versionId: string;
    storeyName: string;
  } | null>(null);
  const chosenCalStorey =
    calStoreyChoice && calStoreyChoice.versionId === activePdfVersionId
      ? calStoreyChoice.storeyName
      : null;

  // Re-run the calibration query while the base model's coordinates are not
  // known yet (floorZ needs the model's vertical shift).
  const [baseTick, setBaseTick] = useState(0);
  const baseAttemptsRef = useRef(0);

  // ── Floor-plan overlay calibration (moved from the old split canvas)
  const overlayCalibration = useLiveQuery(async () => {
    if (!activePdfVersionId || !activeBuildingId) return null;
    const version = await db.pdfVersions.get(activePdfVersionId);
    if (!version) return null;

    const allCals = (await db.calibrations
      .where("pdfFileId")
      .equals(version.pdfFileId)
      .toArray()) as CalibrationRecord[];
    // Prefer calibrations stamped with the current project; fall back
    // to any (legacy rows not yet re-keyed) only when none match.
    const projectCals = projectId
      ? allCals.filter((c) => c.projectId === projectId)
      : [];
    const cals = projectCals.length > 0 ? projectCals : allCals;
    const buildingStoreys = (await db.storeys
      .where("buildingId")
      .equals(activeBuildingId)
      .toArray()) as StoreyRecord[];
    const buildingStoreyNames = new Set(
      buildingStoreys.map((s) => s.name),
    );
    // Lowest raw elevation per storey name orders the chooser (bottom
    // floor first) and makes the default pick deterministic.
    const storeyOrder = new Map<string, number>();
    for (const s of buildingStoreys) {
      const prev = storeyOrder.get(s.name);
      if (prev === undefined || s.elevation < prev) {
        storeyOrder.set(s.name, s.elevation);
      }
    }
    const validCals = cals
      .filter((c) => buildingStoreyNames.has(c.storeyName))
      .sort(
        (a, b) =>
          (storeyOrder.get(a.storeyName) ?? 0) -
            (storeyOrder.get(b.storeyName) ?? 0) ||
          a.storeyName.localeCompare(b.storeyName),
      );
    if (validCals.length === 0) return null;

    const activeStorey = activeStoreyId
      ? await db.storeys.get(activeStoreyId)
      : undefined;
    let cal: CalibrationRecord | null = null;
    if (chosenCalStorey) {
      cal = validCals.find((c) => c.storeyName === chosenCalStorey) ?? null;
    }
    if (!cal && activeStorey) {
      cal = validCals.find((c) => c.storeyName === activeStorey.name) ?? null;
    }
    if (!cal) cal = validCals[0];

    // Floor Z in world metres: current IFC versions only, the open
    // level's model first, each model's unit scale applied.
    const ifcFiles = await db.ifcFiles
      .where("buildingId")
      .equals(activeBuildingId)
      .toArray();
    const currentVersionIds = new Set(
      ifcFiles.map((f) => f.currentVersionId).filter(Boolean),
    );
    if (
      shouldDeferForBaseShift(viewerRef.current, currentVersionIds.size > 0, baseAttemptsRef.current)
    ) {
      // The model has not loaded yet: its vertical shift is unknown, so do not
      // place the plane at an unshifted floor. Retry shortly.
      baseAttemptsRef.current += 1;
      setTimeout(() => setBaseTick((t) => t + 1), BASE_COORD_RETRY_MS);
      return null;
    }
    baseAttemptsRef.current = 0;
    const floorZ =
      resolveStoreyFloorZ(cal.storeyName, buildingStoreys, {
        currentVersionIds,
        preferredIfcFileId:
          activeStorey?.name === cal.storeyName
            ? activeStorey.sourceIfcFileId
            : null,
        centroidY: viewerRef.current?.getModelCentroid()?.y ?? null,
        // Geometry sits at elevation + the base model's y shift.
        modelShiftY: viewerRef.current?.getBaseCoordinates?.()?.[1] ?? null,
      }) ?? 0;

    return {
      versionId: activePdfVersionId,
      pdfFileId: version.pdfFileId,
      calibration: cal,
      transformParams: cal.transformParams,
      floorZ,
      pageWidth: version.width,
      pageHeight: version.height,
      storeyOptions: validCals.map((c) => c.storeyName),
    };
  }, [
    projectId,
    activePdfVersionId,
    activeBuildingId,
    activeStoreyId,
    chosenCalStorey,
    baseTick,
  ]);

  // Wave 58 — ref mirror of the calibration so the seed/place helpers
  // (useCallback'd, no deps) always read the freshest value without
  // stale closures. Updated every time the live query resolves.
  const overlayCalibrationRef = useRef(overlayCalibration);
  useEffect(() => {
    overlayCalibrationRef.current = overlayCalibration;
  }, [overlayCalibration]);

  // Wave 52 reuse — Overlap overlays the mapped PDF as a textured
  // plane on the SHARED surface (the old Task-24 right-viewer
  // machinery, repointed at the persistent viewer).
  // Wave 63 — overlay opacity from the toolbar slider (live, persisted).
  const overlayOpacityPct = useOverlayOpacityStore((st) => st.pct);
  const overlayState = useFloorPlanOverlay(
    viewerRef,
    activePdfVersionId,
    overlayCalibration ?? null,
    mode === "overlap",
    overlayOpacityPct / 100,
  );

  // Entering overlap (from split, or on load) frames the calibrated page from
  // straight above. The split view leaves the camera at first-person eye height
  // (horizontal): without this the plan plane is seen at a grazing angle.
  // Once per (PDF version, calibration) entry; leaving overlap re-arms it.
  const overlapFramedRef = useRef<string | null>(null);
  useEffect(() => {
    if (mode !== "overlap") {
      overlapFramedRef.current = null;
      return;
    }
    if (!overlayCalibration || !surfaceLoaded) return;
    const key = `${overlayCalibration.versionId}|${overlayCalibration.calibration.id}`;
    if (overlapFramedRef.current === key) return;
    const handle = viewerRef.current;
    if (!handle) return;
    overlapFramedRef.current = key;
    const pose = overlapTopDownPose(
      overlayCalibration.transformParams,
      overlayCalibration.pageWidth,
      overlayCalibration.pageHeight,
      overlayCalibration.floorZ,
      handle.getPose({ silent: true }) ?? null,
    );
    handle.setViewPose(pose, { animate: false });
  }, [mode, overlayCalibration, surfaceLoaded, viewerRef]);

  // Floor clip plane during overlap — cut everything above the
  // calibrated floor so the overlaid plan reads cleanly.
  useEffect(() => {
    const enabled = mode === "overlap" && overlayCalibration !== null;
    const floorZ = overlayCalibration?.floorZ ?? 0;
    viewerRef.current?.setFloorClipPlane(enabled, floorZ);
  }, [mode, overlayCalibration, viewerRef]);

  // ── Leaving LinkView: hand the shared surface back untouched ─────
  // The 3D surface is the SAME instance the Models route shows. Save
  // the pose it had when LinkView took it (the first readable pose: on
  // a cold load that is once the surface has loaded, still before the
  // nav seed below moves it), and on unmount put the camera back and
  // drop the overlap floor clip. (The first-person hook gives the
  // orbit mouse buttons back in its own cleanup.)
  const entryPoseRef = useRef<ViewerPose | null>(null);
  useEffect(() => {
    if (entryPoseRef.current) return;
    entryPoseRef.current =
      viewerRef.current?.getPose({ silent: true }) ?? null;
  }, [surfaceLoaded, viewerRef]);
  useEffect(() => {
    return () => {
      const handle = viewerRef.current;
      if (!handle) return;
      handle.setFloorClipPlane(false, 0);
      const pose = entryPoseRef.current;
      if (pose) handle.setViewPose(pose, { animate: false });
    };
  }, [viewerRef]);

  // ── Wave 57/58: navigation view (marker + camera linkage) ──────
  // Active only in Split mode with a calibrated PDF open in the left
  // pane. navPdfPos is the marker's PDF page position; navBearing is
  // the marker's cone direction (radians). The marker and the
  // shared-surface camera stay locked both directions through the
  // calibration similarity transform, with a one-source-of-truth
  // dragging flag so the two never fight.
  const [navPdfPos, setNavPdfPos] = useState<PdfPoint | null>(null);
  const navPdfPosRef = useRef<PdfPoint | null>(null);
  const [navBearing, setNavBearing] = useState(0);
  const navBearingRef = useRef(0);
  const navDraggingRef = useRef(false);
  const seededNavRef = useRef<string | null>(null);
  // Wave 58 — parked seed intent (cold load): when the calibrated PDF
  // auto-opens before the shared surface finishes loading, we park the
  // camera seed here and replay it once surfaceLoaded flips true.
  const pendingNavSeedRef = useRef<string | null>(null);
  // First-person fix — the pdf version the camera was last seeded
  // for (state, so the first-person controls engage only once the
  // camera actually stands at eye height on the mapped storey).
  const [navSeededFor, setNavSeededFor] = useState<string | null>(null);

  const navActive = mode === "split" && overlayCalibration !== null;
  // One nav seed per (PDF version, calibration): picking another
  // storey of the same PDF re-seeds the camera on that floor.
  const navKey =
    overlayCalibration && overlayCalibration.versionId === activePdfVersionId
      ? `${overlayCalibration.versionId}|${overlayCalibration.calibration.id}`
      : null;

  // Leaving Split (→ Overlap) forgets the seed, so coming back
  // re-seeds the first-person camera instead of leaving the orbit
  // camera where Overlap put it with the controls never re-locked.
  useEffect(() => {
    if (mode === "split") return;
    seededNavRef.current = null;
    pendingNavSeedRef.current = null;
    navDraggingRef.current = false;
    setNavSeededFor(null);
  }, [mode]);

  // Tear down the nav view whenever the calibration goes away (PDF
  // closed, non-calibrated PDF, building switch).
  useEffect(() => {
    if (!overlayCalibration) {
      setNavPdfPos(null);
      navPdfPosRef.current = null;
      navDraggingRef.current = false;
      seededNavRef.current = null;
      pendingNavSeedRef.current = null;
      setNavBearing(0);
      navBearingRef.current = 0;
      setNavSeededFor(null);
    }
  }, [overlayCalibration]);

  // Apply the nav seed for a calibrated PDF: a FIRST-PERSON camera at
  // the calibration start point, EYE_HEIGHT above the mapped storey's
  // floor, looking horizontally toward the model centroid. (Wave 58
  // had swapped this for a straight-down camera at the level-plan
  // framing height, which turned the right pane into a top-down plan.)
  const applyNavSeed = useCallback(
    (
      key: string,
      seed: {
        versionId: string;
        calibration: CalibrationRecord;
        floorZ: number;
      },
    ): void => {
      if (`${seed.versionId}|${seed.calibration.id}` !== key) return;
      const worldStart = seedWorldPoint(seed.calibration);
      const centroid = viewerRef.current?.getModelCentroid() ?? null;
      const bearing = bearingTowardCentroid(worldStart, centroid);
      navBearingRef.current = bearing;
      setNavBearing(bearing);
      const currentPose =
        viewerRef.current?.getPose({ silent: true }) ?? null;
      const pose = firstPersonPose(
        worldStart,
        seed.floorZ,
        bearing,
        0,
        currentPose,
      );
      viewerRef.current?.setViewPose(pose, { animate: false });
      setNavSeededFor(key);
    },
    [viewerRef],
  );

  // Seed the marker + camera ONCE per calibrated-PDF open. The marker
  // position is set immediately (the marker itself waits for
  // pdfOverlay.onReady); the CAMERA seed is either consumed right away
  // (warm surface) or parked in pendingNavSeedRef (cold load).
  useEffect(() => {
    if (mode !== "split") return;
    if (!activePdfVersionId || !overlayCalibration) return;
    // Guard the transient stale-live-query race: the calibration must
    // correspond to the ACTIVE pdf version (a PDF switch can briefly
    // carry the previous PDF's calibration).
    if (!navKey) return;
    if (seededNavRef.current === navKey) return;
    if (pendingNavSeedRef.current === navKey) return;

    const pdfStart = seedPdfPoint(overlayCalibration.calibration);
    setNavPdfPos(pdfStart);
    navPdfPosRef.current = pdfStart;

    if (surfaceLoaded) {
      seededNavRef.current = navKey;
      applyNavSeed(navKey, overlayCalibration);
    } else {
      // Cold load: park the camera seed until the surface is warm.
      pendingNavSeedRef.current = navKey;
    }
  }, [
    mode,
    activePdfVersionId,
    navKey,
    overlayCalibration,
    surfaceLoaded,
    viewerRef,
    applyNavSeed,
  ]);

  // Consume the parked seed ONCE when surfaceLoaded flips true.
  useEffect(() => {
    if (!surfaceLoaded) return;
    const pending = pendingNavSeedRef.current;
    if (!pending) return;
    if (seededNavRef.current === pending) return;
    const cal = overlayCalibrationRef.current;
    if (!cal || `${cal.versionId}|${cal.calibration.id}` !== pending) {
      // Calibration moved on (PDF switched while the surface was
      // still cold) — the seed effect above will re-park/re-seed.
      return;
    }
    pendingNavSeedRef.current = null;
    seededNavRef.current = pending;
    applyNavSeed(pending, cal);
  }, [surfaceLoaded, applyNavSeed]);

  // 3D → PDF linkage: poll the shared surface's camera while nav is
  // active and back-project its plan position onto the PDF. The marker
  // BEARING is also live-updated from the pose's horizontal look
  // component (holding the last valid bearing when the pose is
  // straight-down / degenerate). Position sync is suppressed while the
  // marker is being dragged (PDF drives 3D in that case).
  //
  // Perf: the loop only does work when something it reads changed —
  // the surface's viewport revision (camera matrices + canvas size),
  // the marker position ref, or the dragging flag — and only calls
  // setState when the bearing moved by more than BEARING_EPSILON (the
  // position is already gated by CAMERA_SYNC_EPSILON). A still camera
  // therefore costs one hash per frame and zero React renders.
  useEffect(() => {
    if (!navActive || !overlayCalibration || !activePdfVersionId) return;
    if (overlayCalibration.versionId !== activePdfVersionId) return;
    // Only once the camera IS the nav camera: on a cold load the seed
    // is parked and the camera is still the default orbit pose — back-
    // projecting that would yank the marker off the calibration start.
    if (!navKey || navSeededFor !== navKey) return;
    if (typeof requestAnimationFrame !== "function") return;

    const params = overlayCalibration.transformParams;
    const pageWidth = overlayCalibration.pageWidth;
    const pageHeight = overlayCalibration.pageHeight;
    let rafId: number | null = null;
    let alive = true;
    // Change gate. `undefined` revision = a handle without the token
    // (test doubles) ⇒ never equal to the sentinel, always dirty.
    const NEVER = Symbol("never");
    let lastRevision: number | undefined | typeof NEVER = NEVER;
    let lastPdf: PdfPoint | null | typeof NEVER = NEVER;
    let lastDragging: boolean | typeof NEVER = NEVER;

    const tick = (): void => {
      if (!alive) return;
      const handle = viewerRef.current;
      if (handle) {
        const revision = handle.getViewportRevision?.();
        const dragging = navDraggingRef.current;
        const dirty =
          revision === undefined ||
          revision !== lastRevision ||
          navPdfPosRef.current !== lastPdf ||
          dragging !== lastDragging;
        // `silent`: a per-frame read, not a viewpoint save.
        const pose = dirty ? handle.getPose({ silent: true }) : null;
        if (pose) {
          lastRevision = revision;
          lastDragging = dragging;
          // Live bearing from the horizontal look azimuth; hold when
          // the pose is degenerate (vertical look = no valid azimuth).
          const liveBearing = bearingFromPose(pose);
          if (
            liveBearing !== null &&
            bearingChanged(navBearingRef.current, liveBearing)
          ) {
            navBearingRef.current = liveBearing;
            setNavBearing(liveBearing);
          }

          const currentPdf = navPdfPosRef.current;
          if (
            currentPdf &&
            shouldBackProjectCamera(navDraggingRef.current, true)
          ) {
            const markerWorld = worldFromPdfPoint(params, currentPdf);
            const cameraWorld = { x: pose.pos[0], z: pose.pos[2] };
            if (planDistance(markerWorld, cameraWorld) > CAMERA_SYNC_EPSILON) {
              const pdf = pdfFromWorldPoint(params, cameraWorld);
              const clamped = clampPdfPoint(pdf, pageWidth, pageHeight);
              navPdfPosRef.current = clamped;
              setNavPdfPos(clamped);
            }
          }
          lastPdf = navPdfPosRef.current;
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      alive = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    navActive,
    activePdfVersionId,
    navKey,
    overlayCalibration,
    navSeededFor,
    viewerRef,
  ]);

  // Move the marker to a PDF page point and TELEPORT the first-person
  // camera there: same eye height on the mapped storey, same bearing
  // and pitch. Shared by marker drags and click-to-place. Instant
  // (no tween) so the camera never lags the marker, and the camera →
  // marker loop never sees a half-way pose.
  const placeNavAt = useCallback(
    (pdfPos: PdfPoint): void => {
      const cal = overlayCalibrationRef.current;
      if (!cal) return;
      const clamped = clampPdfPoint(
        pdfPos,
        cal.pageWidth,
        cal.pageHeight,
      );
      setNavPdfPos(clamped);
      navPdfPosRef.current = clamped;
      const world = worldFromPdfPoint(cal.transformParams, clamped);
      const currentPose =
        viewerRef.current?.getPose({ silent: true }) ?? null;
      const pitch = currentPose ? pitchFromPose(currentPose) : 0;
      const pose = firstPersonPose(
        world,
        cal.floorZ,
        navBearingRef.current,
        pitch,
        currentPose,
      );
      viewerRef.current?.setViewPose(pose, { animate: false });
    },
    [viewerRef],
  );

  // Marker drag handlers — PDF drives 3D.
  const handleNavDragStart = useCallback(() => {
    navDraggingRef.current = true;
  }, []);

  const handleNavDragMove = useCallback(
    (pdfPos: PdfPoint) => {
      placeNavAt(pdfPos);
    },
    [placeNavAt],
  );

  const handleNavDragEnd = useCallback(() => {
    navDraggingRef.current = false;
  }, []);

  // Click-to-place: while nav is active, a click (not drag) anywhere
  // on the PDF moves the marker there and re-centers the camera — the
  // old click-to-place-spawn behaviour ("we can start any point in the
  // pdf"). Reuses placeNavAt (same conversion as the drag handler).
  const handleNavPdfClick = useCallback(
    (pdfPos: PdfPoint) => {
      placeNavAt(pdfPos);
    },
    [placeNavAt],
  );

  // ── First-person controls on the shared surface ─────────────────
  // Drag-look + WASD/arrows at eye height while the nav view is
  // engaged; releasing restores the orbit controls (shared instance).
  const [surfaceHostEl, setSurfaceHostEl] = useState<HTMLElement | null>(
    null,
  );
  const registerSurfaceHost = useCallback(
    (node: HTMLElement | null) => {
      setSurfaceHostEl(node);
      registerHost(node);
    },
    [registerHost],
  );
  const firstPersonActive =
    navActive && navKey !== null && navSeededFor === navKey;
  const [coarsePointer] = useState(hasCoarsePointer);
  const showTouchWalk = isMobile || coarsePointer;
  const firstPerson = useFirstPersonControls({
    viewerRef,
    hostEl: surfaceHostEl,
    active: firstPersonActive,
    floorZ: overlayCalibration?.floorZ ?? 0,
    bearingRef: navBearingRef,
  });

  // ── Auto-pick the first building (idempotent backstop; the kernel
  // also auto-selects into the same shared store) ────────────────────
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    (async () => {
      const buildings = await db.buildings
        .where("projectId")
        .equals(projectId)
        .toArray();
      if (cancelled) return;
      buildings.sort((a, b) => a.createdAt - b.createdAt);
      if (!useModelsToolStore.getState().activeBuildingId) {
        setActiveBuildingId(buildings[0]?.id ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, setActiveBuildingId]);

  // ── Wave 55: level-plan open with load-retry ──────────────────────
  // openLevel() fails while the left viewer is still loading (the
  // LevelPlanController's storey metadata only lands after the first
  // model load). Wave 52 dropped that failure and never retried —
  // the left pane stayed empty forever. Now the intent is parked in
  // pendingOpenRef and replayed on the viewer's onLoadedModelsChange.
  const pendingOpenRef = useRef<{ storeyId: string; name: string } | null>(
    null,
  );
  const [leftLoadTick, setLeftLoadTick] = useState(0);

  const openStoreyPlan = useCallback(
    async (storeyId: string, name: string) => {
      setActivePdfVersionId(null);
      // Optimistic: the row highlights and the EmptyPane goes away
      // immediately; the retry machinery below completes the open
      // once the models are in.
      setActiveStoreyId(storeyId);
      const intent = { storeyId, name };
      pendingOpenRef.current = intent;
      const handle = leftViewerRef.current;
      if (!handle) return;
      const opened = await handle.openLevel(name);
      if (opened && pendingOpenRef.current === intent) {
        pendingOpenRef.current = null;
        handle.setActiveTool("navigation");
      }
    },
    [],
  );

  // Subscribe to the LEFT viewer's model-load events (the left pane
  // only exists in split mode with a building selected).
  useEffect(() => {
    const handle = leftViewerRef.current;
    if (!handle || mode !== "split" || !activeBuildingId) return;
    // Wave 64 — drop ONLY this subscription on cleanup. Passing `null`
    // would clear every listener on the handle (e.g. the express-id
    // map hook's), not just ours.
    const unsubscribe = handle.onLoadedModelsChange((count) => {
      if (count > 0) setLeftLoadTick((t) => t + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [mode, activeBuildingId, leftLoadTick]);

  // Replay a parked open once the models land.
  useEffect(() => {
    if (leftLoadTick === 0) return;
    const pending = pendingOpenRef.current;
    const handle = leftViewerRef.current;
    if (!pending || !handle) return;
    let cancelled = false;
    void (async () => {
      const opened = await handle.openLevel(pending.name);
      if (cancelled) return;
      if (opened && pendingOpenRef.current === pending) {
        pendingOpenRef.current = null;
        setActiveStoreyId(pending.storeyId);
        handle.setActiveTool("navigation");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [leftLoadTick]);

  // ── Model Floor Plans row click → openLevel on the LEFT viewer ─────
  const handleActivateStorey = useCallback(
    async (storeyId: string) => {
      const storey = await db.storeys.get(storeyId);
      if (!storey?.name) {
        // eslint-disable-next-line no-console
        console.warn(
          `[LinkviewApp] activate storey ${storeyId}: missing or unnamed row`,
        );
        return;
      }
      await openStoreyPlan(storeyId, storey.name);
    },
    [openStoreyPlan],
  );

  // ── Models & Levels panel: a level row opens its plan on the LEFT ──
  // The panel reports a storey NAME; resolve it to this building's
  // storey row (prefer an extracted one) and reuse the Model Floor
  // Plans path, so the 3D pane keeps its first-person / orbit view.
  const handleOpenLevel = useCallback(
    async (levelName: string) => {
      if (!activeBuildingId) return;
      const candidates = await db.storeys
        .where("buildingId")
        .equals(activeBuildingId)
        .filter((st) => st.name === levelName)
        .toArray();
      const storey = candidates[0];
      if (!storey) {
        // eslint-disable-next-line no-console
        console.warn(`[LinkviewApp] open level "${levelName}": no storey row`);
        return;
      }
      await openStoreyPlan(storey.id, storey.name);
    },
    [activeBuildingId, openStoreyPlan],
  );
  const activeLevelName =
    useLiveQuery(
      async () =>
        activeStoreyId ? (await db.storeys.get(activeStoreyId))?.name ?? null : null,
      [activeStoreyId],
    ) ?? null;

  // ── setActiveStoreyName wrapper: keep activeStoreyId in sync ───────
  const handleSetActiveStoreyName = useCallback((name: string | null) => {
    if (name === null) {
      setActiveStoreyId(null);
    }
  }, []);

  // ── Building change clears PDF + storey selections ────────────────
  const handleBuildingChange = useCallback(
    (buildingId: string) => {
      setActiveBuildingId(buildingId);
      setActivePdfVersionId(null);
      setActiveStoreyId(null);
      pendingOpenRef.current = null;
      leftViewerRef.current?.closeLevel();
    },
    [setActiveBuildingId],
  );

  // ── Non-blank open (wave 55 fix; Maintainer 2026-11-08 17:41) ───────────
  // "Make sure the left 2d view does not start empty — if no mapped
  // PDFs exist, show the first level it finds." Priority: first
  // mapped PDF → first extracted level → first model level. Both
  // live queries must be RESOLVED (undefined = in flight) before
  // deciding, so the PDF-vs-level priority can't be raced by
  // resolution order. The model-level fallback runs a direct query
  // and only claims the building when something actually opened for
  // selection — late-arriving data still re-triggers via the live
  // queries above.
  const mappedPdfsSignal = useLiveQuery(
    () =>
      projectId
        ? queryMappedPdfsForBuilding(projectId, activeBuildingId)
        : [],
    [projectId, activeBuildingId],
  );
  const extractedStoreysSignal = useLiveQuery(
    () => queryExtractedStoreysForBuilding(activeBuildingId),
    [activeBuildingId],
  );
  const autoSelectRef = useRef<string | null>(null);
  useEffect(() => {
    if (!projectId || !activeBuildingId) return;
    if (autoSelectRef.current === activeBuildingId) return;
    if (
      mappedPdfsSignal === undefined ||
      extractedStoreysSignal === undefined
    ) {
      return; // live queries still resolving for this building
    }

    // Decide from DIRECT reads, never from the signal values: the
    // live queries can transiently carry the PREVIOUS building's
    // result right after a switch, which raced the PDF-vs-level
    // priority (caught by the wave-55 test suite). The signals only
    // serve as re-trigger deps when data lands late (demo seed).
    let cancelled = false;
    // A task quick-access open claims the building (autoSelectRef) while
    // these reads are in flight: its sheet must not be replaced.
    const stale = (): boolean =>
      cancelled || autoSelectRef.current === activeBuildingId;
    void (async () => {
      const pdfs = await queryMappedPdfsForBuilding(
        projectId,
        activeBuildingId,
      );
      if (stale()) return;
      if (pdfs.length > 0) {
        autoSelectRef.current = activeBuildingId;
        setActivePdfVersionId(pdfs[0].latestVersion.id);
        return;
      }
      const extracted =
        await queryExtractedStoreysForBuilding(activeBuildingId);
      if (stale()) return;
      if (extracted.length > 0) {
        autoSelectRef.current = activeBuildingId;
        await openStoreyPlan(
          extracted[0].storey.id,
          extracted[0].storey.name,
        );
        return;
      }
      // Priority 3: any model storey (lowest elevation wins — the
      // getStoreysForBuilding semantics) read as StoreyRecord rows so
      // the open intent carries the real storey id.
      const storeyRows = (await db.storeys
        .where("buildingId")
        .equals(activeBuildingId)
        .toArray()) as StoreyRecord[];
      if (stale()) return;
      if (storeyRows.length === 0) return; // nothing yet — don't claim
      storeyRows.sort((a, b) => a.elevation - b.elevation);
      autoSelectRef.current = activeBuildingId;
      await openStoreyPlan(storeyRows[0].id, storeyRows[0].name);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activeBuildingId,
    projectId,
    mappedPdfsSignal,
    extractedStoreysSignal,
    openStoreyPlan,
  ]);

  // ── LinkView dual location ────────────────────────────────────────
  // Creation: a 3D tap on the shared surface also stores the matching
  // plan pin + plan snapshot (and origin 'linkview') through the
  // tasks-react creation seam. The enricher reads refs, so it always sees
  // the sheet that is open right now; it returns null (an ordinary 3D
  // task) when no calibrated sheet is open or the point is off the page.
  const activePdfVersionIdRef = useRef(activePdfVersionId);
  activePdfVersionIdRef.current = activePdfVersionId;
  useEffect(() => {
    setTaskLocationEnricher((location, { projectId: pid, taskId }) => {
      const cal = overlayCalibrationRef.current;
      if (!cal || cal.versionId !== activePdfVersionIdRef.current) return null;
      const made = linkviewLocationFromBim(location, {
        pdfFileId: cal.pdfFileId,
        versionId: cal.versionId,
        calibration: cal.calibration,
        pageWidth: cal.pageWidth,
        pageHeight: cal.pageHeight,
      });
      if (!made) return null;
      // plan snapshot cropped around the pin; null -> no thumb, creation never blocks
      const dataUrl = pdfOverlayRef.current?.getPageSnapshot?.(1, made.uv, 400) ?? null;
      const { location: withThumb, thumb } = attachPlanSnapshotThumb(dataUrl, pid, taskId, made.location);
      return { location: withThumb, thumb2d: thumb };
    });
    return () => setTaskLocationEnricher(null);
  }, []);

  // Quick access: a LinkView task opens the sheet at its pin AND restores
  // the 3D view. The sheet switch claims the building's auto-select so the
  // "first mapped PDF" default does not replace it.
  const openTaskSheetVersion = useCallback(
    (versionId: string) => {
      autoSelectRef.current = useModelsToolStore.getState().activeBuildingId;
      setActivePdfVersionId(versionId);
      setActiveStoreyId(null);
    },
    [],
  );
  useLinkviewTaskOpen({
    overlayRef: pdfOverlayRef,
    viewerRef,
    activeBuildingId,
    activePdfVersionId,
    openVersion: openTaskSheetVersion,
    // Opening a calibrated sheet re-seeds the first-person camera: restore after it.
    cameraSettled:
      mode !== "split" ||
      activePdfVersionId === null ||
      (navKey !== null && navSeededFor === navKey),
  });

  // 2D task pins on the open sheet (the pin quick access highlights).
  const planPins =
    activePdfVersionId && overlayCalibration && overlayCalibration.versionId === activePdfVersionId ? (
      <TaskCalloutLayer2D
        key={activePdfVersionId}
        getSurface={() => pdfOverlayRef.current}
        pdfFileId={overlayCalibration.pdfFileId}
        pageSize={{ width: overlayCalibration.pageWidth, height: overlayCalibration.pageHeight }}
        buildingId={activeBuildingId}
      />
    ) : null;

  // ── Wave 55: the tools toolbar + panel slot, anchored to the RIGHT
  // (3D) pane by LinkviewSplitCanvas' `chrome` slot ──────────────────
  // Memoized so the (memoized) split canvas — and the second
  // IfcViewer + PdfOverlay inside it — don't re-render when only the
  // nav marker's live state changes.
  const chrome = useMemo(
    () => (
      <>
        <LinkviewNavToolbar
          activePanel={activePanel}
          onTogglePanel={handleTogglePanel}
          mode={mode}
          onModeChange={handleModeChange}
          mobile={isMobile}
        />
        <LinkviewNavPanel
          activePanel={activePanel}
          onClose={handleClosePanel}
          mobile={isMobile}
          buildingId={activeBuildingId}
          onBuildingChange={handleBuildingChange}
          activePdfVersionId={activePdfVersionId}
          onActivatePdf={setActivePdfVersionId}
          activeStoreyId={activeStoreyId}
          onActivateStorey={handleActivateStorey}
          onOpenLevel={handleOpenLevel}
          activeLevelName={activeLevelName}
        />
      </>
    ),
    [
      activePanel,
      handleTogglePanel,
      mode,
      handleModeChange,
      isMobile,
      handleClosePanel,
      activeBuildingId,
      handleBuildingChange,
      activePdfVersionId,
      activeStoreyId,
      handleActivateStorey,
      handleOpenLevel,
      activeLevelName,
    ],
  );

  return (
    <div
      style={shellStyle}
      className="ff-linkview-shell"
      data-testid="linkview-app"
    >
      <LinkviewSplitCanvas
        buildingId={activeBuildingId}
        activePdfVersionId={activePdfVersionId}
        activeStoreyId={activeStoreyId}
        setActiveStoreyName={handleSetActiveStoreyName}
        leftViewerRef={leftViewerRef}
        mode={mode}
        surfaceViewerRef={viewerRef}
        registerHost={registerSurfaceHost}
        surfaceLoaded={surfaceLoaded}
        chrome={chrome}
        pdfOverlayRef={pdfOverlayRef}
        planOverlay={planPins}
        onPdfClick={navActive ? handleNavPdfClick : undefined}
        measureCalibration={
          overlayCalibration
            ? {
                metresPerUnit: overlayCalibration.transformParams.scale,
                pageWidth: overlayCalibration.pageWidth,
                pageHeight: overlayCalibration.pageHeight,
              }
            : null
        }
      />
      {navActive && navPdfPos !== null && (
        <LinkviewNavMarker
          // Remount per PDF: the overlay rebuilds its viewer (and its
          // annotation layer) for each version.
          key={activePdfVersionId ?? "none"}
          pdfOverlayRef={pdfOverlayRef}
          pageWidth={overlayCalibration?.pageWidth}
          pdfPos={navPdfPos}
          bearing={
            overlayCalibration
              ? pdfBearingFromWorld(
                  overlayCalibration.transformParams,
                  navBearing,
                )
              : navBearing
          }
          onDragStart={handleNavDragStart}
          onDragMove={handleNavDragMove}
          onDragEnd={handleNavDragEnd}
        />
      )}
      {overlayCalibration && overlayCalibration.storeyOptions.length >= 2 && (
        <label
          data-testid="linkview-cal-storey-picker"
          style={storeyPickerStyle}
        >
          <span>Storey</span>
          <select
            data-testid="linkview-cal-storey-select"
            aria-label="Calibrated storey for this PDF"
            value={overlayCalibration.calibration.storeyName}
            onChange={(e) => {
              if (!activePdfVersionId) return;
              setCalStoreyChoice({
                versionId: activePdfVersionId,
                storeyName: e.target.value,
              });
            }}
            style={{ font: "inherit" }}
          >
            {overlayCalibration.storeyOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {firstPersonActive && showTouchWalk && (
        <div
          data-testid="linkview-walk-buttons"
          role="group"
          aria-label="Walk"
          style={walkButtonsStyle}
        >
          {(
            [
              ["KeyW", "Walk forward", "\u25B2"],
              ["KeyS", "Walk back", "\u25BC"],
            ] as const
          ).map(([code, label, glyph]) => (
            <button
              key={code}
              type="button"
              data-testid={`linkview-walk-${code === "KeyW" ? "forward" : "back"}`}
              aria-label={label}
              title={label}
              onPointerDown={(e) => {
                e.preventDefault();
                e.currentTarget.setPointerCapture?.(e.pointerId);
                firstPerson.pressKey(code);
              }}
              onPointerUp={() => firstPerson.releaseKey(code)}
              onPointerCancel={() => firstPerson.releaseKey(code)}
              onLostPointerCapture={() => firstPerson.releaseKey(code)}
              onContextMenu={(e) => e.preventDefault()}
              style={walkButtonStyle}
            >
              {glyph}
            </button>
          ))}
        </div>
      )}
      {overlayState.error && (
        <div role="alert" data-testid="linkview-overlay-error" style={{ position: "absolute", bottom: 8, left: 8, fontSize: 11, color: "var(--ff-error-text, #c0392b)" }}>
          {overlayState.error.message}
        </div>
      )}
    </div>
  );
}

// Touch devices get on-screen walk buttons (no keyboard).
function hasCoarsePointer(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches
    );
  } catch {
    return false;
  }
}

const storeyPickerStyle: CSSProperties = {
  position: "absolute",
  left: 8,
  bottom: 8,
  zIndex: 30,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 8px",
  borderRadius: 6,
  background: "var(--ff-bg-panel, rgba(255,255,255,0.94))",
  border: "1px solid var(--ff-border, #d0d3d6)",
  boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
  fontSize: 12,
};

const walkButtonsStyle: CSSProperties = {
  position: "absolute",
  right: 12,
  bottom: 12,
  zIndex: 30,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const walkButtonStyle: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 24,
  border: "1px solid var(--ff-border, #d0d3d6)",
  background: "var(--ff-bg-panel, rgba(255,255,255,0.94))",
  boxShadow: "0 1px 4px rgba(0,0,0,0.18)",
  fontSize: 18,
  touchAction: "none",
  userSelect: "none",
  cursor: "pointer",
};

const shellStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "row",
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  fontFamily: "var(--ff-font-stack)",
  overflow: "hidden",
  position: "relative",
};
