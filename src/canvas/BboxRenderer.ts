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
import { getPaletteColor, getTrackColor, type RGB } from "@/lib/colorPalettes";
import { UNCOLORED_PREDICTED_NODE_COLOR } from "./SkeletonRenderer";

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

/** Caption text color that stays readable on a tag of `bg` (dark on light colors like yellow). */
export function captionTextColor([r, g, b]: RGB): string {
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "black" : "white";
}

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
      ctx.fillStyle = captionTextColor(box.color);
      ctx.textBaseline = "bottom";
      ctx.fillText(caption, x + 3 * px, y);
    }
  }
  ctx.restore();
}

/** Resize handles on the selected (axis-aligned) box. */
export function renderBboxHandles(
  ctx: CanvasRenderingContext2D,
  rect: { x1: number; y1: number; x2: number; y2: number },
  color: RGB,
  zoom: number,
): void {
  const px = 1 / Math.max(zoom, 1e-6);
  const half = 4 * px;
  const cx = (rect.x1 + rect.x2) / 2;
  const cy = (rect.y1 + rect.y2) / 2;
  const pts: [number, number][] = [
    [rect.x1, rect.y1], [cx, rect.y1], [rect.x2, rect.y1], [rect.x2, cy],
    [rect.x2, rect.y2], [cx, rect.y2], [rect.x1, rect.y2], [rect.x1, cy],
  ];
  ctx.save();
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5 * px;
  ctx.fillStyle = "white";
  ctx.strokeStyle = css(color);
  for (const [x, y] of pts) {
    ctx.fillRect(x - half, y - half, half * 2, half * 2);
    ctx.strokeRect(x - half, y - half, half * 2, half * 2);
  }
  ctx.restore();
}

/** Outline of a box being drawn, moved or resized. */
export function renderBboxPreview(
  ctx: CanvasRenderingContext2D,
  corners: [number, number][],
  zoom: number,
): void {
  if (corners.length < 2) return;
  const px = 1 / Math.max(zoom, 1e-6);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(corners[0][0], corners[0][1]);
  for (const [x, y] of corners.slice(1)) ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
  ctx.fill();
  ctx.lineWidth = 2 * px;
  ctx.setLineDash([5 * px, 3 * px]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
  ctx.restore();
}

/**
 * Color of one box. Boxes have no nodes, so they can't use the pose rule's
 * per-node colouring (whose instance color is a neutral grey) or its grey for
 * untracked instances; every box gets a real color:
 *
 * - a predicted box with "Color predicted" off: yellow, like predicted nodes;
 * - "color by instance" and linked to a pose instance: that instance's color;
 * - on a track (its own, or its linked instance's): the track's color;
 * - otherwise: the palette color for its position among the frame's boxes.
 */
export function bboxColor(opts: {
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
  if (opts.colorTarget === "instance" && opts.linkedInstanceColor) return opts.linkedInstanceColor;
  if (opts.track) {
    const idx = opts.tracks.indexOf(opts.track);
    return getTrackColor(opts.palette, idx >= 0 ? idx : opts.index, opts.track.name ?? null, opts.trackColorOverrides);
  }
  return getPaletteColor(opts.palette, opts.index);
}
