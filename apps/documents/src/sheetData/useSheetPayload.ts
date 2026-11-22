// apps/documents/src/sheetData/useSheetPayload.ts
//
// Loads the embedded sheet payload of the PDF shown in the overlay.
// The overlay builds its pdf.js document asynchronously, so this polls
// the handle (like the annotation-layer resolver) until the document is
// readable, then reads the attachment ONCE per PDF version (cached).

import { useEffect, useState, type RefObject } from "react";

import type { PdfOverlayHandle } from "@ff/viewer-react";

import {
  getCachedPayload,
  readSheetPayload,
  setCachedPayload,
  type AttachmentSource,
  type SheetPayload,
} from "./sheetPayload";

const POLL_MS = 200;
const GIVE_UP_MS = 15_000;

/**
 * `undefined` while loading, `null` when the PDF carries no sheet data,
 * the payload otherwise.
 */
export function useSheetPayload(
  overlayRef: RefObject<PdfOverlayHandle | null> | null | undefined,
  pdfVersionId: string | null,
): SheetPayload | null | undefined {
  const [state, setState] = useState<{ id: string | null; payload: SheetPayload | null | undefined }>({
    id: null,
    payload: undefined,
  });

  useEffect(() => {
    if (!pdfVersionId) {
      setState({ id: null, payload: null });
      return;
    }
    const cached = getCachedPayload(pdfVersionId);
    if (cached !== undefined) {
      setState({ id: pdfVersionId, payload: cached });
      return;
    }
    setState({ id: pdfVersionId, payload: undefined });
    let cancelled = false;
    let reading = false;
    const started = Date.now();
    const tick = (): void => {
      if (cancelled || reading) return;
      const doc = overlayRef?.current?.getDocument() as unknown as AttachmentSource | null | undefined;
      if (!doc) {
        if (Date.now() - started > GIVE_UP_MS) {
          clearInterval(timer);
          setState({ id: pdfVersionId, payload: null });
        }
        return;
      }
      reading = true;
      clearInterval(timer);
      void readSheetPayload(doc).then((payload) => {
        if (cancelled) return;
        // A failed read (undefined) is shown as "no data" but never cached.
        if (payload !== undefined) setCachedPayload(pdfVersionId, payload);
        setState({ id: pdfVersionId, payload: payload ?? null });
      });
    };
    const timer = setInterval(tick, POLL_MS);
    tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [overlayRef, pdfVersionId]);

  return state.id === pdfVersionId ? state.payload : undefined;
}
