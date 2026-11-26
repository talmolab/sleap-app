/**
 * Centroid overlay: draws a frame's `LabeledFrame.centroids` (one point per
 * animal, e.g. a Centroid Only run's predictions) as a ringed cross.
 *
 * Split like the box renderer: {@link buildRenderedCentroids} turns the data
 * model into image-space points (pure, unit-tested) and
 * {@link renderCentroids} paints them. Centroids are in source (full-frame)
 * coordinates; the caller passes the same `toImage` mapping the poses use.
 */
import { PredictedCentroid, type Centroid } from "@talmolab/sleap-io.js";
import type { RGB } from "@/lib/colorPalettes";
import { captionTextColor } from "./BboxRenderer";

/** One centroid, ready to draw. */
export interface RenderedCentroid {
  /** Index into the frame's `centroids` array. */
  index: number;
  /** Position in image coordinates. */
  x: number;
  y: number;
  color: RGB;
  isPredicted: boolean;
  /** Prediction score (predicted centroids only). */
  score?: number;
  /** Category, else track name, else null. */
  label: string | null;
}

export interface BuildCentroidOptions {
  toImage: (x: number, y: number) => [number, number];
  colorFor: (centroid: Centroid, index: number) => RGB;
}

/** Turn a frame's centroids into image-space points. Ones without a position are skipped. */
export function buildRenderedCentroids(
  centroids: readonly Centroid[],
  opts: BuildCentroidOptions,
): RenderedCentroid[] {
  const out: RenderedCentroid[] = [];
  centroids.forEach((c, index) => {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
    const [x, y] = opts.toImage(c.x, c.y);
    const isPredicted = c instanceof PredictedCentroid;
    out.push({
      index,
      x,
      y,
      color: opts.colorFor(c, index),
      isPredicted,
      score: isPredicted ? (c as PredictedCentroid).score : undefined,
      label: c.category || c.track?.name || null,
    });
  });
  return out;
}

export interface CentroidRenderOptions {
  /** Image px → screen px, to keep the marker a constant size on screen. */
  zoom: number;
  /** 0–1 opacity (shared with poses). */
  opacity: number;
  /** Draw the label/score caption. */
  showLabels: boolean;
}

const css = ([r, g, b]: RGB, a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;

/** Text drawn next to a centroid: label and/or score. Null when there's nothing to show. */
export function centroidCaption(c: Pick<RenderedCentroid, "label" | "score">): string | null {
  const score = c.score !== undefined && Number.isFinite(c.score) ? c.score.toFixed(2) : null;
  if (c.label && score) return `${c.label} ${score}`;
  return c.label ?? score;
}

/** Paint centroids. Assumes the image transform is already applied to `ctx`. */
export function renderCentroids(
  ctx: CanvasRenderingContext2D,
  centroids: readonly RenderedCentroid[],
  opts: CentroidRenderOptions,
): void {
  if (centroids.length === 0) return;
  const px = 1 / Math.max(opts.zoom, 1e-6);
  const r = 7 * px;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opts.opacity));
  for (const c of centroids) {
    // Dark halo, then the colored ring and cross, so it reads on any video.
    for (const [stroke, width] of [["rgba(0, 0, 0, 0.6)", 3.5], [css(c.color), 1.75]] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * px;
      ctx.setLineDash(c.isPredicted && width < 3 ? [3 * px, 2 * px] : []);
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(c.x - r * 1.5, c.y);
      ctx.lineTo(c.x + r * 1.5, c.y);
      ctx.moveTo(c.x, c.y - r * 1.5);
      ctx.lineTo(c.x, c.y + r * 1.5);
      ctx.stroke();
    }

    const caption = opts.showLabels ? centroidCaption(c) : null;
    if (caption) {
      const fontPx = 11 * px;
      ctx.font = `${fontPx}px sans-serif`;
      const w = ctx.measureText(caption).width;
      const x = c.x + r * 1.2;
      const y = c.y - r * 1.2;
      ctx.fillStyle = css(c.color, 0.85);
      ctx.fillRect(x, y - fontPx - 2 * px, w + 6 * px, fontPx + 3 * px);
      ctx.fillStyle = captionTextColor(c.color);
      ctx.textBaseline = "bottom";
      ctx.fillText(caption, x + 3 * px, y);
    }
  }
  ctx.restore();
}
