// apps/documents/src/sheetData/SheetHighlight.tsx
//
// A subtle highlight of the picked element: an SVG portaled into the PDF
// viewer's annotation layer (viewBox = page in points), so it tracks
// zoom / pan for free. Draws the exact outline when the element has one,
// else its bbox.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { useAnnotationLayer, type AnnotationLayerSurface } from "@ff/tasks-react/useAnnotationLayer";

import type { SheetElement } from "./sheetPayload";

export interface SheetHighlightProps {
  getSurface: () => AnnotationLayerSurface | null;
  page: { width: number; height: number } | null;
  /** Every element to highlight (one pick, or all instances of a category). */
  elements: readonly SheetElement[];
}

export default function SheetHighlight({ getSurface, page, elements }: SheetHighlightProps): ReactNode {
  const view = useAnnotationLayer(getSurface, page?.width);
  if (!view.layer || !page || elements.length === 0 || view.page !== 1) return null;
  // Screen-constant stroke: 2px / render scale.
  const stroke = 2 / Math.max(view.scale, 0.01);
  return createPortal(
    <svg
      data-testid="sheet-highlight-svg"
      viewBox={`0 0 ${page.width} ${page.height}`}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        overflow: "visible",
        pointerEvents: "none",
      }}
    >
      {elements.map((element, i) => {
        const [x0, y0, x1, y1] = element.bbox;
        return element.outline ? (
          <polygon
            key={i}
            data-testid="sheet-highlight-outline"
            points={element.outline.map((p) => p.join(",")).join(" ")}
            fill="rgba(37, 99, 235, 0.12)"
            stroke="rgba(37, 99, 235, 0.9)"
            strokeWidth={stroke}
          />
        ) : (
          <rect
            key={i}
            data-testid="sheet-highlight-bbox"
            x={x0}
            y={y0}
            width={x1 - x0}
            height={y1 - y0}
            fill="rgba(37, 99, 235, 0.12)"
            stroke="rgba(37, 99, 235, 0.9)"
            strokeWidth={stroke}
          />
        );
      })}
    </svg>,
    view.layer,
  );
}
