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

// ── Tracks occupancy band (separate resizable row) ───────────────────────────

/** Per-track SLOT height (px): a thin lane + a gap between lanes. The lane band
 *  canvas is drawn at `trackCount * TRACKS_LANE_PX` (full detail, all tracks) and
 *  scrolls inside the resizable viewport, so this is the true per-track pitch. */
export const TRACKS_LANE_PX = 6;

/** Gap (px) between lanes within a slot — the drawn lane is `laneHeight - GAP`. */
export const TRACKS_LANE_GAP_PX = 2;

/** Minimum drawn per-track slot (px). Above this, lanes GROW to fill the band as
 *  it's dragged taller; at/below it (too many tracks to fit) the band scrolls. */
export const TRACKS_MIN_LANE_PX = 5;

/** Buffer (px) reserved at the TOP of the band so the first lane doesn't butt
 *  against the drag handle — mirrors the header graph's top headroom. */
export const TRACKS_TOP_PAD_PX = 4;

/**
 * Per-track lane geometry for a given band (viewport) height and track count.
 * A {@link TRACKS_TOP_PAD_PX} buffer is reserved at the top; the remaining height
 * is shared by the lanes, which grow to fill it (`usable / count`) but never
 * below {@link TRACKS_MIN_LANE_PX}. `canvasHeight` = pad + lanes: it equals the
 * band height while lanes fill it (no scroll), and exceeds it once lanes bottom
 * out at the minimum (so the viewport scrolls). Pure + testable.
 */
export function tracksLaneMetrics(
  bandHeight: number,
  laneCount: number
): { laneHeight: number; canvasHeight: number } {
  const n = Math.max(laneCount, 1);
  const usable = Math.max(0, bandHeight - TRACKS_TOP_PAD_PX);
  const laneHeight = Math.max(TRACKS_MIN_LANE_PX, usable / n);
  const canvasHeight =
    laneCount > 0 ? TRACKS_TOP_PAD_PX + laneHeight * laneCount : 0;
  return { laneHeight, canvasHeight };
}

/** Floor for the tracks band VIEWPORT (px) — its compact single-strip look. */
export const TRACKS_MIN_HEIGHT = 12;

/** Cap for the AUTO viewport height (px). Enough to show ~20 lanes; beyond that
 *  the band scrolls (the user can drag it taller up to {@link TRACKS_MAX_HEIGHT}). */
export const TRACKS_AUTO_MAX_HEIGHT = 120;

/** Largest viewport height the user can drag the tracks band to (px). */
export const TRACKS_MAX_HEIGHT = 400;

/**
 * Auto height (px) for the tracks band from the track count: `count * lanePx`,
 * clamped to `[TRACKS_MIN_HEIGHT, TRACKS_AUTO_MAX_HEIGHT]`. Used when the user
 * hasn't manually resized the band (the stored height is 0 = "auto").
 */
export function autoTracksHeight(
  trackCount: number,
  lanePx = TRACKS_LANE_PX
): number {
  const raw = Math.max(0, Math.round(trackCount)) * lanePx;
  return Math.max(TRACKS_MIN_HEIGHT, Math.min(TRACKS_AUTO_MAX_HEIGHT, raw));
}

/**
 * The height (px) to render the tracks band at: the user's manually-set height
 * when they've dragged it (`storedHeight > 0`, clamped to the drag range), else
 * the auto height for `trackCount`. A stored `0` means "auto" (never resized, or
 * reset), so a new project always auto-fits its own track count.
 */
export function effectiveTracksHeight(
  storedHeight: number,
  trackCount: number
): number {
  if (storedHeight > 0) {
    return Math.max(
      TRACKS_MIN_HEIGHT,
      Math.min(TRACKS_MAX_HEIGHT, Math.round(storedHeight))
    );
  }
  return autoTracksHeight(trackCount);
}

/**
 * Map a top-edge drag to a new clamped tracks-band height. Like
 * {@link resizeHeaderHeight} (drag up grows), but clamped to the tracks band's
 * own `[TRACKS_MIN_HEIGHT, TRACKS_MAX_HEIGHT]` range.
 */
export function resizeTracksHeight(
  startHeight: number,
  startClientY: number,
  currentClientY: number
): number {
  return clampHeaderHeight(startHeight + (startClientY - currentClientY), {
    min: TRACKS_MIN_HEIGHT,
    max: TRACKS_MAX_HEIGHT,
  });
}
