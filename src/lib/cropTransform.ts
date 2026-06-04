/**
 * Virtual-crop coordinate transforms for cropped videos (SLP-2.3 `pkg.slp`).
 *
 * A cropped video displays a fixed *window* of the source frame: sleap-io.js's
 * `CropVideoBackend` serves the cropped image in crop-local pixel space, but
 * instance points are stored in SOURCE coordinates. These helpers bridge the
 * two, keyed on the video's single crop rect (`Video.cropRect`, which is
 * per-video, not per-frame).
 *
 * For an uncropped video (`cropRect === null`) every helper is the identity, so
 * normal `.slp` / `pkg.slp` files are completely unaffected.
 */
import type { Video } from "@/types";

/** Crop origin `[x1, y1]` in source coords, or `null` when the video is uncropped. */
export function cropOrigin(video: Video | null): [number, number] | null {
  const rect = video?.cropRect ?? null;
  return rect ? [rect[0], rect[1]] : null;
}

/**
 * Source-frame `(x, y)` → displayed crop-local image coords (subtracts the crop
 * origin). Identity when uncropped. `NaN` (unplaced nodes) is preserved.
 */
export function toImageCoords(
  video: Video | null,
  x: number,
  y: number
): [number, number] {
  const o = cropOrigin(video);
  return o ? [x - o[0], y - o[1]] : [x, y];
}

/**
 * Displayed crop-local image `(x, y)` → source-frame coords (adds the crop
 * origin). Inverse of {@link toImageCoords}; identity when uncropped. Used when
 * writing back interactive edits (node placement / drag) so stored points stay
 * in source coordinates.
 */
export function toSourceCoords(
  video: Video | null,
  x: number,
  y: number
): [number, number] {
  const o = cropOrigin(video);
  return o ? [x + o[0], y + o[1]] : [x, y];
}
