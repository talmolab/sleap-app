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

/** Draw every layer's poses. `edges` are node-index pairs in the project's node order. */
export function renderModelOverlay(
  ctx: CanvasRenderingContext2D,
  layers: readonly ModelOverlayLayer[],
  edges: readonly (readonly [number, number])[],
  opts: ModelOverlayRenderOptions
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
}
