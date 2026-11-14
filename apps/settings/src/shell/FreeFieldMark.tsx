// FreeField brand mark — the floor-plan "F" with a location pin.
//
// This is the compact, small-size variant (bold walls, enlarged pin,
// no dimension ticks) so it stays legible at 16–24px. The walls use
// `currentColor` so the mark follows whatever text colour its host
// sets (rail, header, dark surfaces); the pin keeps the brand coral.
//
// Full-detail artwork lives in `public/brand/` (freefield-mark.svg,
// freefield-icon.svg, and the paper-background PNG originals).

export const FF_BRAND_CORAL = "#DE6B55";

export interface FreeFieldMarkProps {
  /** Rendered width and height in px. Default 20. */
  size?: number;
  /** Accessible name; omit for a decorative mark (aria-hidden). */
  title?: string;
}

export default function FreeFieldMark({
  size = 20,
  title,
}: FreeFieldMarkProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      data-testid="freefield-mark"
      style={{ flexShrink: 0, display: "block" }}
    >
      <path
        d="M14.2 11.5 V8.3 H25.5 V3 H7 V29.5 H14.2 V20 H22.3 V14.7 H17.6"
        stroke="currentColor"
        strokeWidth={2.6}
        strokeLinejoin="miter"
      />
      <path
        d="M14.2 7.6 a4.3 4.3 0 0 1 4.3 4.3 c0 2.9 -2.4 5.1 -4.3 8 c-1.9 -2.9 -4.3 -5.1 -4.3 -8 a4.3 4.3 0 0 1 4.3 -4.3 z"
        fill={FF_BRAND_CORAL}
      />
      <circle cx="14.2" cy="11.7" r="1.4" fill="#FFFFFF" />
    </svg>
  );
}
