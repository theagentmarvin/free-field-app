// apps/documents/src/sheetData/SheetDataLayer.tsx
//
// "Drawings are data" for the Documents viewer. When the open PDF embeds
// `freefield-sheet.json`, taps on the drawing pick the element under the
// finger (selection in the shared store: the Properties / Elements / Schedules
// panels of the floating toolbar read it, and the selection is highlighted on
// the page) or follow a section / elevation / callout head to the target sheet
// (with a "Back to <sheet>" breadcrumb). A link to a sheet that is not in the
// bundle shows a hint. A plain PDF has no attachment: nothing happens.
//
// This layer renders no panel of its own: only the highlight, the breadcrumb and
// the transient hint.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import { db } from "@ff/data/db/database";
import type { PdfOverlayHandle } from "@ff/viewer-react";

import SheetHighlight from "./SheetHighlight";
import { hitTestSheet } from "./hitTest";
import { loadSheetNumber } from "./loadSheetNumber";
import { isNavigableLink, notIncludedHint, resolveSheetPdf, type SheetNumberReader, type SheetPdfRef } from "./sheetLinks";
import { useSheetDataStore } from "./sheetDataStore";
import { useSheetPayload } from "./useSheetPayload";

export interface SheetDataLayerHandle {
  /** Feed a tap in PDF page points (y down). */
  handleTap(coords: { x: number; y: number }): void;
}

export interface SheetDataLayerProps {
  overlayRef: RefObject<PdfOverlayHandle | null> | null | undefined;
  pdfVersionId: string;
  pdfFileId: string | null;
  page: { width: number; height: number } | null;
  /** Open another PDF version in the viewer. */
  onNavigate: (pdfVersionId: string) => void;
  /** Reads a PDF version's embedded sheet number (test seam; default reads the PDF). */
  readSheetNumber?: SheetNumberReader;
  /** Called when a tap picked an element (the host opens the Properties panel). */
  onElementTapped?: () => void;
}

interface TrailEntry {
  versionId: string;
  label: string;
}

/** PDFs of the building that owns `pdfFileId`, with their latest version. */
async function loadBuildingSheetPdfs(pdfFileId: string | null): Promise<SheetPdfRef[]> {
  if (!pdfFileId) return [];
  const file = await db.pdfFiles.get(pdfFileId);
  if (!file) return [];
  const files = await db.pdfFiles.where("buildingId").equals(file.buildingId).toArray();
  const out: SheetPdfRef[] = [];
  for (const f of files) {
    const versions = await db.pdfVersions.where("pdfFileId").equals(f.id).toArray();
    const latest = versions.find((v) => v.isLatest) ?? versions.sort((a, b) => b.versionNumber - a.versionNumber)[0];
    if (latest) out.push({ pdfFileId: f.id, name: f.name, versionId: latest.id });
  }
  return out;
}

const NOTICE_MS = 4500;

const SheetDataLayer = forwardRef<SheetDataLayerHandle, SheetDataLayerProps>(function SheetDataLayer(
  { overlayRef, pdfVersionId, pdfFileId, page, onNavigate, readSheetNumber = loadSheetNumber, onElementTapped },
  ref,
) {
  const payload = useSheetPayload(overlayRef, pdfVersionId);
  const setPayload = useSheetDataStore((s) => s.setPayload);
  const clearSelection = useSheetDataStore((s) => s.clearSelection);
  const selectedGids = useSheetDataStore((s) => s.selectedGids);
  const [notice, setNotice] = useState<string | null>(null);
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const pendingNavRef = useRef<string | null>(null);

  // Publish the payload for the panels.
  useEffect(() => {
    setPayload(payload);
  }, [payload, setPayload]);
  useEffect(() => () => setPayload(undefined), [setPayload]);

  // A different PDF clears the pick; the breadcrumb survives only for
  // navigations this layer started.
  useEffect(() => {
    clearSelection();
    setNotice(null);
    if (pendingNavRef.current === pdfVersionId) pendingNavRef.current = null;
    else setTrail([]);
  }, [pdfVersionId, clearSelection]);

  // The hint disappears by itself.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const readSheetNumberRef = useRef(readSheetNumber);
  readSheetNumberRef.current = readSheetNumber;
  const pdfFileIdRef = useRef(pdfFileId);
  pdfFileIdRef.current = pdfFileId;
  const versionRef = useRef(pdfVersionId);
  versionRef.current = pdfVersionId;
  const onElementTappedRef = useRef(onElementTapped);
  onElementTappedRef.current = onElementTapped;

  const navigateTo = useCallback(
    (target: SheetPdfRef): void => {
      const label = payloadRef.current?.sheetNumber || "previous sheet";
      setTrail((t) => [...t, { versionId: versionRef.current, label }]);
      pendingNavRef.current = target.versionId;
      onNavigate(target.versionId);
    },
    [onNavigate],
  );

  useImperativeHandle(
    ref,
    () => ({
      handleTap: ({ x, y }) => {
        const p = payloadRef.current;
        if (!p) return;
        if ((overlayRef?.current?.getCurrentPage() ?? 1) !== 1) return;
        const hit = hitTestSheet(p, x, y);
        setNotice(null);
        if (!hit) {
          useSheetDataStore.getState().clearSelection();
          return;
        }
        if (hit.kind === "link") {
          const link = hit.link;
          if (!isNavigableLink(link)) {
            // The target sheet was not exported: say so instead of a dead click.
            setNotice(notIncludedHint(link));
            return;
          }
          const tappedOn = versionRef.current;
          void loadBuildingSheetPdfs(pdfFileIdRef.current)
            .then((pdfs) => resolveSheetPdf(link.targetSheetNumber, pdfs, readSheetNumberRef.current))
            .then((target) => {
              // The user may have moved to another sheet while this resolved.
              if (versionRef.current !== tappedOn) return;
              if (target && target.versionId !== versionRef.current) navigateTo(target);
              else if (!target) setNotice(`Sheet ${link.targetSheetNumber} is not in this building.`);
            });
          return;
        }
        useSheetDataStore.getState().selectElement(hit.element.gid);
        onElementTappedRef.current?.();
      },
    }),
    [navigateTo, overlayRef],
  );

  const highlighted = useMemo(() => {
    if (!payload || selectedGids.length === 0) return [];
    const want = new Set(selectedGids);
    const seen = new Set<string>();
    return payload.elements.filter((e) => {
      if (!want.has(e.gid)) return false;
      // one polygon per drawn instance (an element may be drawn in several views)
      return !seen.has(`${e.gid}|${e.bbox.join(",")}`) && seen.add(`${e.gid}|${e.bbox.join(",")}`);
    });
  }, [payload, selectedGids]);

  const getSurface = useCallback(() => overlayRef?.current ?? null, [overlayRef]);

  const back = (): void => {
    const last = trail[trail.length - 1];
    if (!last) return;
    setTrail((t) => t.slice(0, -1));
    pendingNavRef.current = last.versionId;
    onNavigate(last.versionId);
  };

  if (!payload) return null;
  const lastTrail = trail[trail.length - 1];
  return (
    <>
      <SheetHighlight getSurface={getSurface} page={page} elements={highlighted} />
      {lastTrail ? (
        <button type="button" style={backStyle} onClick={back} data-testid="sheet-back">
          ← Back to {lastTrail.label}
        </button>
      ) : null}
      {notice ? (
        <div style={noticeStyle} role="status" data-testid="sheet-notice">
          {notice}
        </div>
      ) : null}
    </>
  );
});

export default SheetDataLayer;

const noticeStyle: CSSProperties = {
  position: "absolute",
  top: 60,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 20,
  maxWidth: "min(480px, calc(100% - 32px))",
  padding: "6px 14px",
  fontSize: 13,
  borderRadius: 8,
  background: "var(--ff-bg-app)",
  color: "var(--ff-text-primary)",
  border: "1px solid var(--ff-border)",
  boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
  pointerEvents: "none",
};
const backStyle: CSSProperties = {
  position: "absolute",
  // Clear of the Documents floating nav toolbar (top-left).
  top: 14,
  left: 330,
  zIndex: 20,
  height: 28,
  padding: "0 12px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 14,
  cursor: "pointer",
  border: "1px solid var(--ff-blue-active)",
  background: "var(--ff-bg-app)",
  color: "var(--ff-blue-active)",
  pointerEvents: "auto",
};
