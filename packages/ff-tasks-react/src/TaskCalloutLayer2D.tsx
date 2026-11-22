import { useTaskOpenState } from "./taskOpenStore";
import { useTaskBuildingIndex } from "./taskBuilding";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useProjectId } from "@ff/auth";

import {
  extractPdfPins,
  mergePdfPins,
  pendingPdfPins,
  pinCanvasPx,
  pinsForFile,
  pinsForPage,
  type LocatablePdfTask,
  type PdfPageSize,
  type PdfPin,
  type PdfPinSurface,
} from "./pdfPins";
import { formatTaskNum, statusColor } from "./logic";
import { pinsForBuilding, PIN_FEED_LIMIT } from "./callouts";
import { useTasksSource } from "./tasksSource";
import { useAnnotationLayer } from "./useAnnotationLayer";
import { useOutboxRows } from "./useOutboxRows";

/**
 * 2D task pins on the PDF plan (plan §6) — the documents-module twin
 * of <TaskCalloutLayer3D>. Cloud-first feed + outbox overlay with D5
 * suppression, consumed through the structural `PdfPinSurface` so
 * ff-tasks-react never imports the viewer package.
 *
 * Markers are portaled into the viewer's annotation layer, which sits
 * inside `.pv-zoom-transform`: it inherits the display zoom, so pin
 * positions are page coords × renderScale set once per scale change —
 * no rAF loop, no rect math (the Task 15b discovery the wizard proved).
 */

export interface TaskCalloutLayer2DProps {
  getSurface: () => PdfPinSurface | null;
  pdfFileId: string;
  /** page size in PDF points, from the active PdfVersionRecord */
  pageSize: PdfPageSize;
  onOpenTask?: (pin: PdfPin) => void;
  /** Active building: only its pins (plus legacy pins without a
   *  building) render. Omit to show every building's pins. */
  buildingId?: string | null;
}

export function TaskCalloutLayer2D({
  getSurface,
  pdfFileId,
  pageSize,
  onOpenTask,
  buildingId,
}: TaskCalloutLayer2DProps): JSX.Element | null {
  const source = useTasksSource();
  const projectId = useProjectId();

  const [cloud, setCloud] = useState<LocatablePdfTask[]>([]);
  useEffect(() => {
    if (!projectId) {
      setCloud([]);
      return;
    }
    let unsub = () => {};
    try {
      unsub = source.watchTasks(projectId, null, (t) => setCloud(t as LocatablePdfTask[]), PIN_FEED_LIMIT);
    } catch {
      /* no backend — outbox pins still render */
    }
    return () => unsub();
  }, [source, projectId]);

  const rows = useOutboxRows(projectId);
  const buildingIndex = useTaskBuildingIndex();

  const pins = useMemo(
    () =>
      pinsForBuilding(
        pinsForFile(mergePdfPins(extractPdfPins(cloud), pendingPdfPins(rows, source.overlaySending)), pdfFileId),
        buildingId,
        buildingIndex,
      ),
    [cloud, rows, pdfFileId, source.overlaySending, buildingId, buildingIndex]
  );

  // Shared annotation-layer resolver (also used by the LinkView nav
  // marker): attach after the viewer is built, gate on onReady,
  // re-read layer/page/scale every tick.
  const view = useAnnotationLayer(getSurface, pageSize.width);
  const { highlightTaskId } = useTaskOpenState();

  if (!view.layer) return null;
  const shown = pinsForPage(pins, view.page);
  if (shown.length === 0) return null;

  return createPortal(
    <div
      style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", pointerEvents: "none" }}
      role="group"
      aria-label="Plan task pins"
    >
      {shown.map((pin) => {
        const { x, y } = pinCanvasPx(pin, pageSize, view.scale);
        const highlighted = highlightTaskId === pin.taskId;
        return (
          <button
            key={pin.taskId}
            type="button"
            className={`ff-callout${pin.pending ? " ff-callout--pending" : ""}${highlighted ? " ff-callout--highlight" : ""}`}
            data-highlighted={highlighted ? "true" : undefined}
            aria-label={`Task ${pin.taskId} — ${pin.title}`}
            onClick={() => onOpenTask?.(pin)}
            style={{
              position: "absolute",
              left: x,
              top: y,
              transform: "translate(-50%, -120%)",
              pointerEvents: "auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "2px 8px",
              borderRadius: 12,
              border: highlighted ? "2px solid #2f6fe4" : "1px solid #d0d3d6",
              background: highlighted ? "#e8f0fe" : "rgba(255,255,255,0.94)",
              boxShadow: highlighted ? "0 0 0 4px rgba(47,111,228,0.28), 0 2px 8px rgba(0,0,0,0.25)" : "0 1px 4px rgba(0,0,0,0.18)",
              zIndex: highlighted ? 5 : undefined,
              cursor: "pointer",
              fontSize: 12,
              opacity: pin.pending ? 0.55 : 1,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: statusColor(pin.status),
                display: "inline-block",
                flex: "0 0 auto",
              }}
            />
            <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatTaskNum(pin.num)}</span>
            {pin.pending && <span style={{ color: "#1a73e8" }}>⋯</span>}
          </button>
        );
      })}
    </div>,
    view.layer
  );
}
