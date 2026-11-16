/**
 * Coordinates for the pictures the Claude connector renders.
 *
 * Three spaces:
 *  - render: pixels in the PNG Claude sees (origin top-left);
 *  - image: pixels in the decoded video frame (crop-local for a cropped video);
 *  - source: where instance points are stored (image + the video's crop offset).
 *
 * Claude only ever deals in render pixels; `renderToFrame` turns its answer
 * into source coordinates, so it never does any math itself.
 */

export interface RenderTransform {
  /** Top-left of the rendered region, in image pixels. */
  originX: number;
  originY: number;
  /** Render pixels per image pixel. */
  scale: number;
  /** The video's crop offset (source = image + offset); 0 when uncropped. */
  offsetX: number;
  offsetY: number;
}

export interface CropPlan {
  originX: number;
  originY: number;
  width: number;
  height: number;
  scale: number;
}

/** Most a crop is enlarged: past this it only blurs. */
export const MAX_UPSCALE = 4;
/** Smallest crop side, in image pixels, so a tiny instance keeps some context. */
export const MIN_CROP_SIDE = 64;

/** Render pixel → source (stored) coordinates. */
export function renderToFrame(t: RenderTransform, rx: number, ry: number): [number, number] {
  return [t.originX + rx / t.scale + t.offsetX, t.originY + ry / t.scale + t.offsetY];
}

/** Source (stored) coordinates → render pixel. */
export function frameToRender(t: RenderTransform, x: number, y: number): [number, number] {
  return [(x - t.offsetX - t.originX) * t.scale, (y - t.offsetY - t.originY) * t.scale];
}

/** Bounding box `[x1, y1, x2, y2]` of the placed, visible points; null if none. */
export function instanceBBox(
  points: readonly { xy: readonly [number, number] | number[]; visible: boolean }[],
): [number, number, number, number] | null {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const p of points) {
    const [x, y] = p.xy;
    if (!p.visible || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return x1 === Infinity ? null : [x1, y1, x2, y2];
}

/**
 * A square crop around `bbox` (image pixels), padded by `pad` × its longest
 * side on each side, clamped inside the frame, and a scale that fits its
 * longest edge in `maxEdge` render pixels: a whole-number enlargement up to
 * {@link MAX_UPSCALE}, or a shrink when the crop is bigger than the budget.
 * No bbox → the whole frame.
 */
export function planCrop(opts: {
  bbox: [number, number, number, number] | null;
  frameW: number;
  frameH: number;
  maxEdge: number;
  pad: number;
}): CropPlan {
  const { bbox, frameW, frameH, maxEdge, pad } = opts;
  let originX = 0;
  let originY = 0;
  let width = frameW;
  let height = frameH;
  if (bbox) {
    const [x1, y1, x2, y2] = bbox;
    const longest = Math.max(x2 - x1, y2 - y1);
    const side = Math.max(MIN_CROP_SIDE, Math.ceil(longest * (1 + 2 * pad)));
    width = Math.min(side, frameW);
    height = Math.min(side, frameH);
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    originX = Math.round(Math.min(Math.max(cx - width / 2, 0), frameW - width));
    originY = Math.round(Math.min(Math.max(cy - height / 2, 0), frameH - height));
  }
  const fit = maxEdge / Math.max(width, height);
  const scale = fit >= 1 ? Math.min(MAX_UPSCALE, Math.floor(fit)) : fit;
  return { originX, originY, width, height, scale };
}
