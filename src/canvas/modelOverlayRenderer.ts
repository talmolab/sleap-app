/**
 * Draws other models' poses (Compare Model Predictions) over the frame.
 *
 * Each model's poses are drawn exactly the way the app draws the project's
 * own predicted instances (SkeletonRenderer's predicted style: gray-filled
 * markers outlined in the colour, thin dashed edges, edge style and marker
 * size from the View settings) — only coloured in that model's colour, as
 * if "colour predicted instances" were on. No node names or track labels,
 * so several models stay readable on top of each other. Missing nodes are
 * skipped. Coordinates are source-frame pixels, mapped through the video's
 * crop like everything else on the canvas.
 */

import type { RGB } from "@/lib/colorPalettes";
import { rgbToCSS } from "@/lib/colorPalettes";
import type { OverlayPose } from "@/lib/modelOverlay/core";
import type { Disagreement } from "@/lib/modelOverlay/matching";
import { renderInstances, type RenderedInstance } from "@/canvas/SkeletonRenderer";
import type { EdgeStyle } from "@/types";

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
  /** Line or Wedge, as for the project's instances. */
  edgeStyle?: EdgeStyle;
  /** Canvas scale (fit × zoom), so strokes stay one screen pixel wide. */
  zoom: number;
  /** Source-frame → displayed image coords (crop). */
  toImage: (x: number, y: number) => [number, number];
}

/** Disagreement rings: red, sized by the spread (at least a marker). */
export const DISAGREEMENT_COLOR: RGB = [255, 40, 40];

/**
 * A model pose as a predicted {@link RenderedInstance} in the model's colour.
 * Missing nodes are marked not visible (and the renderer is told not to draw
 * non-visible nodes), so they and their edges are skipped.
 */
export function modelPoseToRendered(
  pose: OverlayPose,
  color: RGB,
  edges: readonly (readonly [number, number])[],
  toImage: (x: number, y: number) => [number, number]
): RenderedInstance {
  const n = pose.xy.length / 2;
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = pose.xy[2 * i];
    const y = pose.xy[2 * i + 1];
    const ok = Number.isFinite(x) && Number.isFinite(y);
    const [ix, iy] = ok ? toImage(x, y) : [0, 0];
    nodes[i] = { x: ix, y: iy, visible: ok, complete: false, name: "" };
  }
  return {
    nodes,
    edges: edges.map(([srcIdx, dstIdx]) => ({ srcIdx, dstIdx })),
    color,
    isPredicted: true,
    isSelected: false,
    trackName: null,
    score: pose.score ?? undefined,
    visible: true,
    showNonVisible: false,
  };
}

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
  const rendered: RenderedInstance[] = [];
  for (const layer of layers) {
    for (const pose of layer.poses) rendered.push(modelPoseToRendered(pose, layer.color, edges, opts.toImage));
  }
  renderInstances(ctx, rendered, {
    markerSize: opts.markerSize,
    poseOpacity: opts.poseOpacity,
    edgeStyle: opts.edgeStyle ?? "Line",
    showInstances: true,
    showEdges: opts.showEdges,
    showLabels: false,
    showNonVisibleNodes: false,
    // Predicted style, but in the model's colour instead of the uncoloured yellow/gray.
    colorPredicted: true,
    showTrackScore: false,
    zoom: opts.zoom,
  });

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
