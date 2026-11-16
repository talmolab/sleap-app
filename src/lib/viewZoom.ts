/**
 * Zoom/pan math for the main video canvas's View ▸ zoom modes.
 *
 * The canvas draws a scene point `p` (in display coordinates, i.e. after
 * rotation) at `offset + pan + p * baseScale * zoom`, where `baseScale` fits
 * the whole frame in the canvas and `zoom` is the user's zoom on top of it.
 */

export interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
}

export interface CanvasFit {
  /** Canvas width and height in CSS pixels. */
  cw: number;
  ch: number;
  /** Scale that fits the whole frame in the canvas. */
  baseScale: number;
  /** Where the fitted frame's top-left corner sits in the canvas. */
  offsetX: number;
  offsetY: number;
}

/**
 * The view that fills the canvas with the box around `points` (plus `pad`
 * scene pixels on each side), centred, never zooming in past `maxZoom`.
 * Null when there is nothing to fit.
 */
export function fitPointsView(
  points: ReadonlyArray<{ x: number; y: number }>,
  fit: CanvasFit,
  pad = 50,
  maxZoom = 10,
): CanvasView | null {
  const { cw, ch, baseScale, offsetX, offsetY } = fit;
  if (points.length === 0 || cw <= 0 || ch <= 0 || baseScale <= 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (minX === Infinity) return null;
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;
  if (bboxW <= 0 || bboxH <= 0) return null;

  const zoom = Math.min(cw / (bboxW * baseScale), ch / (bboxH * baseScale), maxZoom);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    zoom,
    panX: cw / 2 - offsetX - centerX * baseScale * zoom,
    panY: ch / 2 - offsetY - centerY * baseScale * zoom,
  };
}

/**
 * View ▸ Actual Size (1:1): one video pixel per canvas pixel, keeping the
 * point at the centre of the canvas where it is (PyQt `zoomToActualSize`).
 */
export function actualSizeView(view: CanvasView, fit: CanvasFit): CanvasView {
  const { cw, ch, baseScale, offsetX, offsetY } = fit;
  if (baseScale <= 0 || view.zoom <= 0) return view;
  const scale = baseScale * view.zoom;
  // Scene point currently under the canvas centre.
  const cx = (cw / 2 - offsetX - view.panX) / scale;
  const cy = (ch / 2 - offsetY - view.panY) / scale;
  // baseScale * zoom === 1 → zoom = 1 / baseScale.
  return { zoom: 1 / baseScale, panX: cw / 2 - offsetX - cx, panY: ch / 2 - offsetY - cy };
}
