/**
 * Pure, React-free fixed-height row windowing math (#160).
 *
 * The Frames panel renders one DOM row per labeled frame, which hangs on large
 * `.slp` files. This helper computes which contiguous slice of rows to actually
 * render for a given scroll position, plus the pixel heights of the top/bottom
 * spacers that stand in for the un-rendered rows so the scrollbar geometry stays
 * exactly the same as if every row were present.
 *
 * It is deliberately framework-agnostic: it takes plain numbers and returns a
 * plain object so it can be unit-tested in isolation and wired into any
 * component (see Task 2: `FramesPanel.tsx`).
 */

export interface VirtualWindow {
  /** First row index to render (inclusive). */
  startIdx: number;
  /** One past the last row index to render (exclusive). */
  endIdx: number;
  /** Pixel height of the top spacer (rows above the window). */
  topPad: number;
  /** Pixel height of the bottom spacer (rows below the window). */
  bottomPad: number;
}

/** Clamps `v` into the inclusive range `[lo, hi]`. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/**
 * Computes the slice of rows to render and the spacer heights for a
 * fixed-row-height virtualized list.
 *
 * Invariant (whenever `rowHeight > 0` and `viewportHeight > 0`):
 *   `topPad + (endIdx - startIdx) * rowHeight + bottomPad === rowCount * rowHeight`
 *
 * @param opts.scrollTop      Current scroll offset of the viewport, in pixels.
 * @param opts.viewportHeight Visible height of the scroll container, in pixels.
 * @param opts.rowHeight      Fixed height of every row, in pixels.
 * @param opts.rowCount       Total number of rows.
 * @param opts.overscan       Extra rows rendered above & below the visible
 *                            range (smooths fast scrolling). Default 8.
 */
export function computeVirtualWindow(opts: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  overscan?: number;
}): VirtualWindow {
  const { scrollTop, viewportHeight, rowHeight, rowCount } = opts;

  // No rows: nothing to render, no spacers.
  if (rowCount <= 0) {
    return { startIdx: 0, endIdx: 0, topPad: 0, bottomPad: 0 };
  }

  // Degenerate geometry: we can't compute a window, so render everything.
  // The `!(x > 0)` idiom is deliberate: it is true for NaN (from a failed
  // measurement / detached node) as well as 0 and negatives, folding all of
  // them into the safe render-all fallback. A plain `x <= 0` would let NaN
  // slip through (NaN comparisons are always false) and poison the math.
  if (!(rowHeight > 0) || !(viewportHeight > 0)) {
    return { startIdx: 0, endIdx: rowCount, topPad: 0, bottomPad: 0 };
  }

  const overscan = opts.overscan ?? 8;

  // Guard against negative or non-finite scrollTop (and floor to the first
  // visible row). A NaN scrollTop is treated as 0 rather than blanking out.
  const safeScrollTop = Number.isFinite(scrollTop) ? scrollTop : 0;
  const first = Math.max(0, Math.floor(safeScrollTop / rowHeight));
  const visibleCount = Math.ceil(viewportHeight / rowHeight);

  const startIdx = clamp(first - overscan, 0, rowCount);
  const endIdx = clamp(first + visibleCount + overscan, startIdx, rowCount);

  const topPad = startIdx * rowHeight;
  const bottomPad = (rowCount - endIdx) * rowHeight;

  return { startIdx, endIdx, topPad, bottomPad };
}
