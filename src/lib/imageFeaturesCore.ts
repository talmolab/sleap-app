/**
 * Pure canvas-geometry math for the image-features suggestion pipeline.
 *
 * These helpers decide the `drawImage` source/destination rects the orchestrator
 * (imageFeatures.ts) uses to crop + downscale each decoded frame in a single GPU
 * op — the actual pixel resampling stays on the canvas, so we never reimplement
 * bilinear resize in JS. They are framework-free and unit-tested directly.
 *
 * The buffer-level math that runs INSIDE the worker on the transferred pixels
 * (grayscale auto-detect, flatten, PCA, k-means) lives in
 * imageFeaturesWorkerCore.ts.
 */

/** An axis-aligned rectangle in source-frame pixel coordinates. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Clamp a (possibly fractional or out-of-bounds) ROI rect to integer pixels
 * inside an `imgWidth × imgHeight` image. A negative origin is normalized by
 * shrinking the box to its visible part. Returns `null` when nothing visible
 * remains (zero/negative area, or fully outside), signalling "use the full
 * frame".
 */
export function clampCropRect(
  rect: CropRect,
  imgWidth: number,
  imgHeight: number
): CropRect | null {
  let x = Math.round(rect.x);
  let y = Math.round(rect.y);
  let w = Math.round(rect.width);
  let h = Math.round(rect.height);

  // Shrink the box to its visible part when the origin is negative.
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }

  // Keep the box within the image bounds.
  w = Math.min(w, imgWidth - x);
  h = Math.min(h, imgHeight - y);

  if (w <= 0 || h <= 0 || x >= imgWidth || y >= imgHeight) return null;
  return { x, y, width: w, height: h };
}

/**
 * Cap the long side of a `width × height` frame to `cap` pixels, preserving
 * aspect ratio and never upscaling (a frame already within the cap is returned
 * unchanged). Neither dimension is allowed to round below 1 pixel. This bounds
 * the flattened feature-vector length (and thus PCA memory/time) independent of
 * the source resolution.
 */
export function capDimensions(
  width: number,
  height: number,
  cap: number
): { width: number; height: number } {
  const longSide = Math.max(width, height);
  if (longSide <= cap) return { width, height };
  const scale = cap / longSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
