/**
 * Alt+drag zoom box on the video canvas, as in PyQt SLEAP's
 * `GraphicsView.mousePressEvent` / `mouseReleaseEvent` (`sleap/gui/widgets/
 * video.py`): Alt + left-drag on empty canvas draws a rectangle, and releasing
 * zooms so the rectangle fills the view (`zoomToRect`). Alt+double-click on
 * empty canvas resets the zoom (`clearZoom`).
 *
 * Pure math, kept apart from VideoPlayer so it can be tested without a canvas.
 */

import { PLACE_CLICK_MAX_MOVE_PX } from "@/lib/canvasGestures";

export interface ModifierState {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** Alt alone, like PyQt's `event.modifiers() == Qt.AltModifier`. */
export function isZoomBoxGesture(mods: ModifierState): boolean {
  return mods.altKey && !mods.shiftKey && !mods.ctrlKey && !mods.metaKey;
}

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface CanvasView {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * A video-frame point in the canvas's rotated scene space (the inverse of the
 * rotation step in VideoPlayer's `canvasToScene`; same as `sceneToClient`).
 */
export function frameToRotated(
  x: number,
  y: number,
  rotation: number,
  frameW: number,
  frameH: number,
): { x: number; y: number } {
  if (rotation === 90) return { x: frameH - y, y: x };
  if (rotation === 180) return { x: frameW - x, y: frameH - y };
  if (rotation === 270) return { x: y, y: frameW - x };
  return { x, y };
}

/**
 * Whether a drawn box is too small to mean anything (a click, or a stray
 * wiggle), measured on screen. `pxPerUnit` is the current baseScale * zoom.
 */
export function isZoomBoxTooSmall(rect: Rect, pxPerUnit: number): boolean {
  const w = Math.abs(rect.x2 - rect.x1) * pxPerUnit;
  const h = Math.abs(rect.y2 - rect.y1) * pxPerUnit;
  return w <= PLACE_CLICK_MAX_MOVE_PX || h <= PLACE_CLICK_MAX_MOVE_PX;
}

/** Same zoom limits as scroll-zoom in VideoPlayer. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 50;

/**
 * The zoom and pan that fit `rect` (rotated scene coords) inside a
 * `containerW` × `containerH` canvas, centered. The whole box stays visible
 * (PyQt's zoomToRect uses the smaller of the two scale factors too).
 * `baseScale` / `offsetX` / `offsetY` are the canvas's fit-to-window transform.
 */
export function viewForZoomRect(
  rect: Rect,
  containerW: number,
  containerH: number,
  baseScale: number,
  offsetX: number,
  offsetY: number,
): CanvasView | null {
  const w = Math.abs(rect.x2 - rect.x1);
  const h = Math.abs(rect.y2 - rect.y1);
  if (w <= 0 || h <= 0 || containerW <= 0 || containerH <= 0 || baseScale <= 0) return null;
  const fitZoom = Math.min(containerW / (w * baseScale), containerH / (h * baseScale));
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
  const cx = (rect.x1 + rect.x2) / 2;
  const cy = (rect.y1 + rect.y2) / 2;
  return {
    zoom,
    panX: containerW / 2 - offsetX - cx * baseScale * zoom,
    panY: containerH / 2 - offsetY - cy * baseScale * zoom,
  };
}
