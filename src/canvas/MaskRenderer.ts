/**
 * Segmentation-mask overlay: draws a frame's `LabeledFrame.masks` (user and
 * predicted) as a translucent fill with an outline.
 *
 * Split like the bbox renderer: {@link buildRenderedMasks} turns the data-model
 * masks into plain placement + color (pure, unit-tested), and
 * {@link renderMasks} paints them.
 *
 * A mask is a binary raster (RLE) in its own pixel grid, placed in source
 * coordinates by `scale` / `offset` (`source = maskPx / scale + offset`). The
 * caller passes the same `toImage` mapping the poses use, so cropped `pkg.slp`
 * videos line up. Painting reuses a cached bitmap + outline per mask
 * ({@link getMaskRaster}), rebuilt only when the mask's `rleCounts` array or
 * color changes, so redraws on hover / zoom / pan cost one `drawImage` and one
 * `stroke` per mask.
 */
import {
  PredictedSegmentationMask,
  traceMaskContours,
  type SegmentationMask,
} from "@talmolab/sleap-io.js";
import { getPaletteColor, getTrackColor, type RGB } from "@/lib/colorPalettes";
import { UNCOLORED_PREDICTED_NODE_COLOR } from "./SkeletonRenderer";
import { captionTextColor } from "./BboxRenderer";

/** One mask, ready to draw. */
export interface RenderedMask {
  /** Index into the frame's `masks` array. */
  index: number;
  mask: SegmentationMask;
  color: RGB;
  isPredicted: boolean;
  /** Prediction score (predicted masks only). */
  score?: number;
  /** Category, else name, else track name, else null. Drawn above the mask. */
  label: string | null;
  /** Image coordinates of mask pixel (0, 0)'s top-left corner. */
  origin: [number, number];
  /** Size of one mask pixel in image pixels (`1 / scale`). */
  pixelSize: [number, number];
  isSelected: boolean;
}

export interface BuildMaskOptions {
  /** Source → image coordinates (identity for uncropped videos). */
  toImage: (x: number, y: number) => [number, number];
  /** Color for the mask at `index`. */
  colorFor: (mask: SegmentationMask, index: number) => RGB;
  /** Currently selected mask, if any. */
  selected?: SegmentationMask | null;
}

/** Turn a frame's masks into image-space placement. Masks with no pixels are skipped. */
export function buildRenderedMasks(
  masks: readonly SegmentationMask[],
  opts: BuildMaskOptions,
): RenderedMask[] {
  const out: RenderedMask[] = [];
  masks.forEach((mask, index) => {
    if (mask.height <= 0 || mask.width <= 0 || mask.area === 0) return;
    const [sx, sy] = mask.scale;
    const isPredicted = mask instanceof PredictedSegmentationMask;
    out.push({
      index,
      mask,
      color: opts.colorFor(mask, index),
      isPredicted,
      score: isPredicted ? (mask as PredictedSegmentationMask).score : undefined,
      label: mask.category || mask.name || mask.track?.name || null,
      origin: opts.toImage(mask.offset[0], mask.offset[1]),
      pixelSize: [1 / sx, 1 / sy],
      isSelected: !!opts.selected && mask === opts.selected,
    });
  });
  return out;
}

/**
 * Color of one mask, following the pose and box rules so a mask reads like the
 * animal it covers:
 *
 * - a predicted mask with "Color predicted" off: yellow, like predicted nodes;
 * - coloring by instance: the linked pose instance's color, else the palette
 *   color for the mask's position;
 * - on a track (its own, or its linked instance's): the track's color;
 * - no track: the palette color for the mask's position. (Boxes share one blue
 *   here; filled masks often touch, so they need to be told apart.)
 */
export function maskColor(opts: {
  index: number;
  isPredicted: boolean;
  colorPredicted: boolean;
  /** Resolved color target ("track" | "instance" | "node" | "edge"). */
  colorTarget: string;
  /** Color of the linked pose instance, when there is one on this frame. */
  linkedInstanceColor?: RGB | null;
  track: { name?: string | null } | null;
  tracks: readonly unknown[];
  palette: string;
  trackColorOverrides?: Record<string, string> | null;
}): RGB {
  if (opts.isPredicted && !opts.colorPredicted) return UNCOLORED_PREDICTED_NODE_COLOR;
  if (opts.colorTarget === "instance") {
    return opts.linkedInstanceColor ?? getPaletteColor(opts.palette, opts.index);
  }
  if (opts.track) {
    const idx = opts.tracks.indexOf(opts.track);
    return getTrackColor(opts.palette, idx >= 0 ? idx : opts.index, opts.track.name ?? null, opts.trackColorOverrides);
  }
  return getPaletteColor(opts.palette, opts.index);
}

/** Text drawn above a mask: label and/or score. Null when there's nothing to show. */
export function maskCaption(mask: Pick<RenderedMask, "label" | "score">): string | null {
  const score =
    mask.score !== undefined && Number.isFinite(mask.score)
      ? mask.score.toFixed(2)
      : null;
  if (mask.label && score) return `${mask.label} ${score}`;
  return mask.label ?? score;
}

/**
 * Tight pixel bounds of a binary raster: `[minCol, minRow, maxCol, maxRow]`
 * (inclusive), or null when it has no foreground pixels.
 */
export function rasterBounds(
  data: ArrayLike<number>,
  height: number,
  width: number,
): [number, number, number, number] | null {
  let minR = height;
  let maxR = -1;
  let minC = width;
  let maxC = -1;
  for (let r = 0; r < height; r++) {
    const base = r * width;
    for (let c = 0; c < width; c++) {
      if (data[base + c]) {
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
      }
    }
  }
  return maxR < 0 ? null : [minC, minR, maxC, maxR];
}

// --- Cached rasters ----------------------------------------------------------

/** A mask's paint-ready form, in mask-pixel coordinates. */
interface MaskRaster {
  /** The `rleCounts` array this was built from (edits assign a new array). */
  key: Uint32Array;
  colorKey: string;
  /** Opaque fill of the foreground, cropped to its bounds. */
  bitmap: HTMLCanvasElement | OffscreenCanvas;
  /** Mask-pixel position of the bitmap's top-left corner. */
  at: [number, number];
  /** Traced boundary (outer rings and holes). */
  outline: Path2D;
  /** Mask-pixel bounds: [minCol, minRow, maxCol + 1, maxRow + 1]. */
  bounds: [number, number, number, number];
}

const rasterCache = new WeakMap<SegmentationMask, MaskRaster>();

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * The cached bitmap + outline for `mask` in `color`, rebuilding only when the
 * mask's `rleCounts` array (edits must assign a new one) or the color changed.
 * Null for an empty mask.
 */
function getMaskRaster(mask: SegmentationMask, color: RGB): MaskRaster | null {
  const colorKey = color.join(",");
  const hit = rasterCache.get(mask);
  if (hit && hit.key === mask.rleCounts && hit.colorKey === colorKey) return hit;

  const { height, width } = mask;
  const data = mask.data;
  const b = rasterBounds(data, height, width);
  if (!b) {
    rasterCache.delete(mask);
    return null;
  }
  const [minC, minR, maxC, maxR] = b;
  const bw = maxC - minC + 1;
  const bh = maxR - minR + 1;
  const bitmap = makeCanvas(bw, bh);
  const bctx = bitmap.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!bctx) return null;
  const img = bctx.createImageData(bw, bh);
  const px = img.data;
  const [r, g, bl] = color;
  for (let y = 0; y < bh; y++) {
    const src = (y + minR) * width + minC;
    const dst = y * bw;
    for (let x = 0; x < bw; x++) {
      if (data[src + x]) {
        const o = (dst + x) * 4;
        px[o] = r;
        px[o + 1] = g;
        px[o + 2] = bl;
        px[o + 3] = 255;
      }
    }
  }
  bctx.putImageData(img, 0, 0);

  const outline = new Path2D();
  for (const ring of traceMaskContours(data, height, width)) {
    if (ring.length < 2) continue;
    outline.moveTo(ring[0][0], ring[0][1]);
    for (let i = 1; i < ring.length; i++) outline.lineTo(ring[i][0], ring[i][1]);
    outline.closePath();
  }

  const raster: MaskRaster = {
    key: mask.rleCounts,
    colorKey,
    bitmap,
    at: [minC, minR],
    outline,
    bounds: [minC, minR, maxC + 1, maxR + 1],
  };
  rasterCache.set(mask, raster);
  return raster;
}

// --- Painting ----------------------------------------------------------------

export interface MaskRenderOptions {
  /** Current canvas scale (image px → screen px), to keep strokes constant on screen. */
  zoom: number;
  /** 0–1 fill opacity. */
  fillOpacity: number;
  /** 0–1 outline + caption opacity (shared with poses). */
  outlineOpacity: number;
  /** Draw the label/score caption. */
  showLabels: boolean;
}

const css = ([r, g, b]: RGB, a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Predicted masks fill at this fraction of the fill opacity, so user masks stand out. */
export const PREDICTED_FILL_FACTOR = 0.6;

/** Paint masks. Assumes the image transform is already applied to `ctx`. */
export function renderMasks(
  ctx: CanvasRenderingContext2D,
  masks: readonly RenderedMask[],
  opts: MaskRenderOptions,
): void {
  if (masks.length === 0) return;
  const zoom = Math.max(opts.zoom, 1e-6);
  const clamp = (a: number) => Math.max(0, Math.min(1, a));
  for (const m of masks) {
    const raster = getMaskRaster(m.mask, m.color);
    if (!raster) continue;
    const [ox, oy] = m.origin;
    const [pw, ph] = m.pixelSize;
    // One screen pixel in mask pixels (the smaller axis, so strokes never thin out).
    const px = 1 / (zoom * Math.min(pw, ph));

    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(pw, ph);

    const fill = opts.fillOpacity * (m.isPredicted ? PREDICTED_FILL_FACTOR : 1) * (m.isSelected ? 1.3 : 1);
    if (fill > 0) {
      ctx.globalAlpha = clamp(fill);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(raster.bitmap, raster.at[0], raster.at[1]);
    }

    ctx.globalAlpha = clamp(opts.outlineOpacity);
    ctx.lineWidth = (m.isSelected ? 3 : 1.5) * px;
    ctx.lineJoin = "round";
    ctx.strokeStyle = css(m.color);
    ctx.setLineDash(m.isPredicted ? [6 * px, 4 * px] : []);
    ctx.stroke(raster.outline);
    ctx.restore();

    const caption = opts.showLabels ? maskCaption(m) : null;
    if (caption) {
      // Anchor above the mask's top-left, in image coordinates.
      const x = ox + raster.bounds[0] * pw;
      const y = oy + raster.bounds[1] * ph - 2 / zoom;
      const fontPx = 11 / zoom;
      ctx.save();
      ctx.globalAlpha = clamp(opts.outlineOpacity);
      ctx.font = `${fontPx}px sans-serif`;
      const w = ctx.measureText(caption).width;
      ctx.fillStyle = css(m.color, 0.85);
      ctx.fillRect(x, y - fontPx - 2 / zoom, w + 6 / zoom, fontPx + 3 / zoom);
      ctx.fillStyle = captionTextColor(m.color);
      ctx.textBaseline = "bottom";
      ctx.fillText(caption, x + 3 / zoom, y);
      ctx.restore();
    }
  }
}

/**
 * A polygon being drawn with the polygon tool: its edges, a rubber-band edge
 * to the cursor, and vertex dots, with the first vertex drawn larger (a click
 * there closes the polygon; it fills when the cursor is close enough). Red
 * when the polygon will cut from the selected mask. Image coordinates; assumes
 * the image transform is applied.
 */
export function renderPolygonPreview(
  ctx: CanvasRenderingContext2D,
  points: readonly [number, number][],
  opts: { zoom: number; cursor?: [number, number] | null; cut?: boolean; canClose?: boolean },
): void {
  if (points.length === 0) return;
  const px = 1 / Math.max(opts.zoom, 1e-6);
  const color = opts.cut ? "rgba(248, 113, 113, 0.95)" : "rgba(255, 255, 255, 0.95)";
  ctx.save();
  ctx.lineJoin = "round";

  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  if (opts.cursor) ctx.lineTo(opts.cursor[0], opts.cursor[1]);
  if (points.length >= 2) {
    ctx.fillStyle = opts.cut ? "rgba(248, 113, 113, 0.12)" : "rgba(255, 255, 255, 0.1)";
    ctx.fill();
  }
  ctx.lineWidth = 2 * px;
  ctx.strokeStyle = color;
  ctx.setLineDash([]);
  ctx.stroke();
  // Dark halo so the outline reads on light video too.
  ctx.lineWidth = 0.75 * px;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  ctx.stroke();

  points.forEach(([x, y], i) => {
    const r = (i === 0 ? 5 : 3) * px;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 && opts.canClose ? color : "rgba(0, 0, 0, 0.7)";
    ctx.fill();
    ctx.lineWidth = 1.5 * px;
    ctx.strokeStyle = color;
    ctx.stroke();
  });
  ctx.restore();
}
