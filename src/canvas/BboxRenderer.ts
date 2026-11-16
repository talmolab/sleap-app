/**
 * Bounding-box overlay: draws a frame's `LabeledFrame.bboxes` (user and
 * predicted, axis-aligned or rotated) on the overlay canvas.
 *
 * Split in two like the pose renderer: {@link buildRenderedBboxes} turns the
 * data-model boxes into plain image-space geometry (pure, unit-tested), and
 * {@link renderBboxes} paints it. Boxes are stored in source (full-frame)
 * coordinates; the caller passes the same `toImage` mapping the poses use, so
 * cropped `pkg.slp` videos line up.
 */
import { PredictedBoundingBox, type BoundingBox } from "@talmolab/sleap-io.js";
import type { RGB } from "@/lib/colorPalettes";

/** One box, ready to draw. */
export interface RenderedBbox {
  /** Index into the frame's `bboxes` array. */
  index: number;
  /**
   * Corners in image coordinates: top-left, top-right, bottom-right,
   * bottom-left before rotation (rotated boxes keep that winding).
   */
  corners: [number, number][];
  color: RGB;
  isPredicted: boolean;
  isRotated: boolean;
  /** Prediction score (predicted boxes only). */
  score?: number;
  /** Category, else track name, else null. Drawn above the box. */
  label: string | null;
  isSelected: boolean;
}

/** True when any corner is NaN (sleap-io's degenerate/empty box). */
export function isEmptyBbox(box: BoundingBox): boolean {
  return (
    Number.isNaN(box.x1) ||
    Number.isNaN(box.y1) ||
    Number.isNaN(box.x2) ||
    Number.isNaN(box.y2)
  );
}

export interface BuildBboxOptions {
  /** Source → image coordinates (identity for uncropped videos). */
  toImage: (x: number, y: number) => [number, number];
  /** Color for the box at `index`. */
  colorFor: (box: BoundingBox, index: number) => RGB;
  /** Currently selected box, if any. */
  selected?: BoundingBox | null;
}

/** Turn a frame's boxes into image-space geometry. Empty boxes are skipped. */
export function buildRenderedBboxes(
  boxes: readonly BoundingBox[],
  opts: BuildBboxOptions,
): RenderedBbox[] {
  const out: RenderedBbox[] = [];
  boxes.forEach((box, index) => {
    if (isEmptyBbox(box)) return;
    const corners = box.corners.map(
      ([x, y]) => opts.toImage(x, y) as [number, number],
    );
    const isPredicted = box instanceof PredictedBoundingBox;
    out.push({
      index,
      corners,
      color: opts.colorFor(box, index),
      isPredicted,
      isRotated: box.isRotated,
      score: isPredicted ? (box as PredictedBoundingBox).score : undefined,
      label: box.category || box.track?.name || null,
      isSelected: !!opts.selected && box === opts.selected,
    });
  });
  return out;
}

/** Text drawn above a box: label and/or score. Null when there's nothing to show. */
export function bboxCaption(box: RenderedBbox): string | null {
  const score =
    box.score !== undefined && Number.isFinite(box.score)
      ? box.score.toFixed(2)
      : null;
  if (box.label && score) return `${box.label} ${score}`;
  return box.label ?? score;
}

export interface BboxRenderOptions {
  /** Current canvas scale (image px → screen px), to keep strokes constant on screen. */
  zoom: number;
  /** 0–1 overall opacity (shared with poses). */
  opacity: number;
  /** Draw the label/score caption. */
  showLabels: boolean;
}

const css = ([r, g, b]: RGB, a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Paint boxes. Assumes the image transform is already applied to `ctx`. */
export function renderBboxes(
  ctx: CanvasRenderingContext2D,
  boxes: readonly RenderedBbox[],
  opts: BboxRenderOptions,
): void {
  if (boxes.length === 0) return;
  const px = 1 / Math.max(opts.zoom, 1e-6);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opts.opacity));
  for (const box of boxes) {
    const [first, ...rest] = box.corners;
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.closePath();

    if (box.isSelected) {
      ctx.fillStyle = css(box.color, 0.12);
      ctx.fill();
    }
    ctx.lineWidth = (box.isSelected ? 3 : 2) * px;
    ctx.strokeStyle = css(box.color);
    ctx.setLineDash(box.isPredicted ? [6 * px, 4 * px] : []);
    ctx.stroke();

    const caption = opts.showLabels ? bboxCaption(box) : null;
    if (caption) {
      const fontPx = 11 * px;
      ctx.setLineDash([]);
      ctx.font = `${fontPx}px sans-serif`;
      const w = ctx.measureText(caption).width;
      // Anchor above the top-most corner (the top-left for unrotated boxes).
      const top = box.corners.reduce((a, b) => (b[1] < a[1] ? b : a));
      const x = top[0];
      const y = top[1] - 2 * px;
      ctx.fillStyle = css(box.color, 0.85);
      ctx.fillRect(x, y - fontPx - 2 * px, w + 6 * px, fontPx + 3 * px);
      ctx.fillStyle = "white";
      ctx.textBaseline = "bottom";
      ctx.fillText(caption, x + 3 * px, y);
    }
  }
  ctx.restore();
}
