/**
 * Pure resize/clamp math for the Seekbar Header (the per-frame instance-count /
 * track-occupancy graph above the scrubbar). The header is vertically
 * resizable via a drag handle on its top edge; these helpers own the
 * px -> height mapping and the min/max clamp so the interaction logic in
 * `Seekbar.tsx` stays declarative and testable.
 */

/** Default header height in px (matches the historical fixed height). */
export const SEEKBAR_HEADER_DEFAULT_HEIGHT = 16;

/**
 * Smallest allowed header height in px. Equal to the default: the header is
 * already compact, so dragging "down" only shrinks a previously-grown header
 * back toward this floor rather than below the original size.
 */
export const SEEKBAR_HEADER_MIN_HEIGHT = 16;

/** Largest allowed header height in px. Tall enough to spread values out. */
export const SEEKBAR_HEADER_MAX_HEIGHT = 240;

/** Optional min/max override for {@link clampHeaderHeight}. */
export interface HeaderHeightBounds {
  min?: number;
  max?: number;
}

/**
 * Clamp a proposed header height to `[min, max]`, rounding to whole pixels.
 * Non-finite input (NaN) resolves to `min` so a bad value can never persist a
 * broken height; +/-Infinity clamp to max/min as usual.
 */
export function clampHeaderHeight(
  next: number,
  {
    min = SEEKBAR_HEADER_MIN_HEIGHT,
    max = SEEKBAR_HEADER_MAX_HEIGHT,
  }: HeaderHeightBounds = {}
): number {
  if (Number.isNaN(next)) return min;
  return Math.max(min, Math.min(max, Math.round(next)));
}

/**
 * Map a top-edge drag to a new clamped header height.
 *
 * The handle sits on the header's TOP edge, so dragging the cursor UP (a
 * smaller clientY) should GROW the header and dragging DOWN should shrink it.
 * The delta is therefore `startClientY - currentClientY`.
 *
 * @param startHeight    header height (px) when the drag began
 * @param startClientY   pointer clientY when the drag began
 * @param currentClientY pointer clientY now
 * @param bounds         optional min/max override
 */
export function resizeHeaderHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number,
  bounds?: HeaderHeightBounds
): number {
  return clampHeaderHeight(startHeight + (startClientY - currentClientY), bounds);
}
