// apps/documents/src/TaskPinDock.tsx
//
// 2D task pins + tap-to-create in the Documents viewer (plan §6,
// Wave 5B tap-to-create entry point). Owns the tasks-module surface —
// engine, people feed, compose sheet, callout layer, + marker — so
// DocumentsViewerPanel itself stays presentational and its existing
// tests never boot Firebase.
//
// Flow (Wave 5B): a plain TAP on a calibrated plan (PdfOverlay's
// `onTap`, already discriminated from drags) forwards page coords;
// the dock looks up the LATEST Dexie calibration for the pdfFileId
// (current project's rows preferred) and anchors a floating + marker at that uv
// through <TapCreateMarker2D>. Tapping the + opens compose prefilled
// with `{pdf: {pdfFileId, page, uv, calibId}}` — the same shape the
// old armed "Add task pin" produced, so the compose→outbox pipeline
// is untouched. Uncalibrated → the "calibrate this plan first" hint,
// no marker (a pin MUST name the calib it trusts); the + marker is
// the sole creation entry point (the old armed button is removed).
// Escape clears the marker.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { requireProjectId, useProjectId } from "@ff/auth";
import { db } from "@ff/data/db/database";
import {
  draftTable,
  latestCalibration,
  locationFromPdfClick,
  TapCreateMarker2D,
  TaskCalloutLayer2D,
  TaskComposeSheet,
  TaskDetailHost,
  attachSnapshotThumb,
  useTaskEngine,
  useTaskPeople,
  useTaskPhotoResolver,
  useTasksFirestore,
  type ComposeLocationThumb,
  type PdfPinSurface,
} from "@ff/tasks-react";

/** The active PDF's pin-relevant metadata (from PdfVersionRecord). */
export interface PinVersionMeta {
  /** PdfVersionRecord.id — stamped on new pins so a revised plan does not inherit them (w72). Optional for older callers. */
  id?: string;
  pdfFileId: string;
  /** page width in PDF points */
  width: number;
  /** page height in PDF points */
  height: number;
}

export interface TaskPinDockProps {
  version: PinVersionMeta;
  /** live PdfOverlay imperative surface (null until the overlay mounts) */
  getSurface: () => PdfPinSurface | null;
  /** Active building — scopes the plan pins (legacy pins always show). */
  buildingId?: string | null;
}

/**
 * Calibrations of the current project for a PDF. The query is by
 * `pdfFileId` (the compound index would also work), and the rows are
 * narrowed to `projectId`: the calibration writer stamps the user's
 * current project, and legacy single-project rows are re-keyed
 * once by `rekeyLegacyProjectData`, so no cross-project fallback.
 */
export function calibrationsForProject<T extends { projectId: string }>(
  rows: readonly T[],
  projectId: string,
): T[] {
  return rows.filter((r) => r.projectId === projectId);
}

/** Imperative door the panel forwards `onTap` through. */
export interface TaskPinDockHandle {
  handleTap(coords: { x: number; y: number }): void;
}

interface PendingPin {
  taskId: string;
  location: NonNullable<ReturnType<typeof locationFromPdfClick>>;
  locationThumb: ComposeLocationThumb | null;
}

/** uuid with a jsdom/older-browser fallback (jsdom <22 lacks randomUUID). */
function newTaskId(): string {
  const c: Crypto | undefined = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const CALIBRATION_HINT = "Calibrate this plan first (Settings → Calibration).";
/**
 * Wave 64 — multi-page PDFs open in the reader, but calibrations (and
 * the page size the uv is normalized over) belong to page 1, so pins
 * can only be created there.
 */
export const PAGE_ONE_HINT = "Task pins can only be placed on page 1 (the calibrated sheet).";

export const TaskPinDock = forwardRef<TaskPinDockHandle, TaskPinDockProps>(
  function TaskPinDock({ version, getSurface, buildingId }, ref) {
    const engine = useTaskEngine();
    const projectId = useProjectId();
    const dbFs = useTasksFirestore();
    const { actor, members, ensureMembers } = useTaskPeople(dbFs, projectId);
    const photoResolver = useTaskPhotoResolver();

    const [pending, setPending] = useState<PendingPin | null>(null);
    const [markerLocation, setMarkerLocation] = useState<
      NonNullable<ReturnType<typeof locationFromPdfClick>> | null
    >(null);
    const [hint, setHint] = useState<string | null>(null);
    const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
      () => () => {
        if (hintTimer.current !== null) clearTimeout(hintTimer.current);
      },
      [],
    );

    function showHint(message: string): void {
      setHint(message);
      if (hintTimer.current !== null) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(null), 4000);
    }

    // Escape clears the pending + marker (a tap = create, so Escape is
    // the natural "never mind" gesture).
    useEffect(() => {
      if (!markerLocation) return;
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === "Escape") setMarkerLocation(null);
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }, [markerLocation]);

    // A discriminated tap on the plan: latest Dexie calibration for
    // this file (current project's rows first), else the hint. Marks a uv but does NOT open
    // compose yet — that waits for the + marker tap.
    async function handleTap(coords: { x: number; y: number }): Promise<void> {
      if (!projectId) return; // no project: no read, no pin
      const page = getSurface()?.getCurrentPage() ?? 1;
      if (page !== 1) {
        showHint(PAGE_ONE_HINT);
        setMarkerLocation(null);
        return;
      }
      const rows = await db.calibrations
        .where("pdfFileId")
        .equals(version.pdfFileId)
        .toArray();
      const calib = latestCalibration(calibrationsForProject(rows, projectId));
      const location = locationFromPdfClick(
        coords,
        { width: version.width, height: version.height },
        version.pdfFileId,
        page,
        calib,
        version.id,
      );
      if (!location) {
        showHint(CALIBRATION_HINT);
        setMarkerLocation(null);
        return;
      }
      setMarkerLocation(location);
    }

    // + marker tap → create: open compose prefilled with the pdf location.
    function openCompose(): void {
      if (!markerLocation) return;
      const pid = requireProjectId(projectId); // write: never without a project
      void ensureMembers();
      const taskId = newTaskId();
      // Day-3: crop the plan around the tapped uv BEFORE opening compose.
      // Null → placeholder; creation never blocks on the snapshot.
      const surface = getSurface();
      const pdf = markerLocation.pdf;
      const page = pdf ? (surface?.getCurrentPage() ?? pdf.page) : 1;
      const dataUrl = pdf
        ? (surface?.getPageSnapshot?.(page, pdf.uv, 400) ?? null)
        : null;
      const { location, thumb } = attachSnapshotThumb(dataUrl, pid, taskId, markerLocation);
      setPending({ taskId, location, locationThumb: thumb });
      setMarkerLocation(null); // marker disappears once compose opens
    }

    useImperativeHandle(ref, () => ({ handleTap }), [version, projectId]);

    return (
      <>
        {/* Plan markers portal into the viewer's annotation layer —
            this element itself renders nothing visible until a pin
            exists. */}
        <TaskCalloutLayer2D
          getSurface={getSurface}
          pdfFileId={version.pdfFileId}
          pageSize={{ width: version.width, height: version.height }}
          onOpenTask={(pin) => setDetailTaskId(pin.taskId)}
          buildingId={buildingId}
        />

        <TapCreateMarker2D
          getSurface={getSurface}
          pageSize={{ width: version.width, height: version.height }}
          markerUv={markerLocation?.pdf?.uv ?? null}
          onMarkerTap={openCompose}
        />

        {hint ? (
          <div role="status" data-testid="task-pin-hint" style={hintStyle}>
            {hint}
          </div>
        ) : null}

        {detailTaskId && (
          <TaskDetailHost
            taskId={detailTaskId}
            onClose={() => setDetailTaskId(null)}
            onShowOnPlan={(pdf) => {
              getSurface()?.goToPage(pdf.page);
            }}
            resolvePhotoUrl={photoResolver}
          />
        )}

        {pending && engine ? (
          <TaskComposeSheet
            projectId={requireProjectId(projectId)}
            taskId={pending.taskId}
            actor={actor}
            members={members ?? []}
            engine={engine}
            draftTable={draftTable}
            location={pending.location}
            locationThumb={pending.locationThumb}
            buildingId={buildingId ?? null}
            onDone={() => setPending(null)}
            onClose={() => setPending(null)}
          />
        ) : null}
      </>
    );
  },
);

const hintStyle: CSSProperties = {
  position: "absolute",
  top: 48,
  left: 8,
  zIndex: 26,
  padding: "6px 12px",
  borderRadius: 8,
  background: "rgba(255,247,230,0.96)",
  border: "1px solid #f0c36d",
  color: "#7a5c00",
  fontSize: 12,
  maxWidth: 280,
  pointerEvents: "none",
};