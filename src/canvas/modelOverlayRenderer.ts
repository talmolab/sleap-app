/**
 * Draws other models' poses (Compare Model Predictions) over the frame.
 *
 * Kept apart from SkeletonRenderer on purpose: these poses aren't project
 * instances (no selection, hover, labels or track names), and each model has
 * one flat colour so the legend reads at a glance. Nodes are filled dots,
 * edges thin solid lines in the model's colour; missing nodes and the edges
 * touching them are skipped. Coordinates are source-frame pixels, mapped
 * through the video's crop like everything else on the canvas.
 */

import type { RGB } from "@/lib/colorPalettes";
import { rgbToCSS } from "@/lib/colorPalettes";
import type { OverlayPose } from "@/lib/modelOverlay/core";
import type { Disagreement } from "@/lib/modelOverlay/matching";

/** One visible model's poses on the current frame. */
export interface ModelOverlayLayer {
  modelId: string;
  color: RGB;
  poses: OverlayPose[];
}

export interface ModelOverlayRenderOptions {
  markerSize: number;
  /** 0–1, the user's pose opacity. */
  poseOpacity: number;
  showEdges: boolean;
  /** Canvas scale (fit × zoom), so strokes stay one screen pixel wide. */
  zoom: number;
  /** Source-frame → displayed image coords (crop). */
  toImage: (x: number, y: number) => [number, number];
}

/** Disagreement rings: red, sized by the spread (at least a marker). */
export const DISAGREEMENT_COLOR: RGB = [255, 40, 40];

/**
 * Draw every layer's poses. `edges` are node-index pairs in the project's node
 * order. `selected` (a pose picked for Accept) gets a dashed box in its
 * model's colour; `disagreements` get red rings around the models' mean
 * position, with a radius of the spread.
 */
export function renderModelOverlay(
  ctx: CanvasRenderingContext2D,
  layers: readonly ModelOverlayLayer[],
  edges: readonly (readonly [number, number])[],
  opts: ModelOverlayRenderOptions,
  extras: {
    selected?: { layer: number; pose: number } | null;
    disagreements?: readonly Disagreement[];
  } = {}
): void {
  if (layers.length === 0) return;
  const r = Math.max(1.5, opts.markerSize * 0.8) / opts.zoom;
  ctx.save();
  ctx.globalAlpha *= opts.poseOpacity;
  for (const layer of layers) {
    const stroke = rgbToCSS(layer.color, 0.85);
    const fill = rgbToCSS(layer.color, 0.9);
    for (const pose of layer.poses) {
      const n = pose.xy.length / 2;
      const pts: ([number, number] | null)[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const x = pose.xy[2 * i];
        const y = pose.xy[2 * i + 1];
        pts[i] = Number.isFinite(x) && Number.isFinite(y) ? opts.toImage(x, y) : null;
      }
      if (opts.showEdges) {
        ctx.beginPath();
        for (const [a, b] of edges) {
          const pa = pts[a];
          const pb = pts[b];
          if (!pa || !pb) continue;
          ctx.moveTo(pa[0], pa[1]);
          ctx.lineTo(pb[0], pb[1]);
        }
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.5 / opts.zoom;
        ctx.stroke();
      }
      ctx.fillStyle = fill;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 0.75 / opts.zoom;
      for (const p of pts) {
        if (!p) continue;
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  const sel = extras.selected;
  const selPose = sel ? layers[sel.layer]?.poses[sel.pose] : undefined;
  if (sel && selPose) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < selPose.xy.length; i += 2) {
      if (!Number.isFinite(selPose.xy[i]) || !Number.isFinite(selPose.xy[i + 1])) continue;
      const [x, y] = opts.toImage(selPose.xy[i], selPose.xy[i + 1]);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (x1 >= x0) {
      const pad = 6 / opts.zoom;
      ctx.save();
      ctx.strokeStyle = rgbToCSS(layers[sel.layer].color);
      ctx.lineWidth = 2 / opts.zoom;
      ctx.setLineDash([5 / opts.zoom, 3 / opts.zoom]);
      ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
      ctx.restore();
    }
  }

  const dis = extras.disagreements ?? [];
  if (dis.length > 0) {
    ctx.save();
    ctx.strokeStyle = rgbToCSS(DISAGREEMENT_COLOR, 0.95);
    ctx.lineWidth = 2 / opts.zoom;
    for (const d of dis) {
      if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) continue;
      const [x, y] = opts.toImage(d.x, d.y);
      ctx.beginPath();
      ctx.arc(x, y, Math.max(d.spread, (opts.markerSize * 1.6) / opts.zoom), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** A model node under the pointer: which layer, pose and node. */
export interface ModelOverlayHit {
  layer: number;
  pose: number;
  node: number;
}

/**
 * The model node nearest (x, y) within `threshold` (displayed image coords),
 * else null. Later layers win ties, matching the draw order (drawn on top).
 */
export function hitTestModelOverlay(
  layers: readonly ModelOverlayLayer[],
  x: number,
  y: number,
  threshold: number,
  toImage: (x: number, y: number) => [number, number]
): ModelOverlayHit | null {
  let best: ModelOverlayHit | null = null;
  let bestD = threshold;
  layers.forEach((layer, li) =>
    layer.poses.forEach((pose, pi) => {
      for (let i = 0; i + 1 < pose.xy.length; i += 2) {
        if (!Number.isFinite(pose.xy[i]) || !Number.isFinite(pose.xy[i + 1])) continue;
        const [px, py] = toImage(pose.xy[i], pose.xy[i + 1]);
        const d = Math.hypot(px - x, py - y);
        if (d <= bestD) {
          bestD = d;
          best = { layer: li, pose: pi, node: i / 2 };
        }
      }
    })
  );
  return best;
}
