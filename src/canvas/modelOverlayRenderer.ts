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
import {
  hitTestInstance,
  hitTestNode,
  renderHoveredNodeHighlight,
  renderHoverInstanceBBox,
  renderInstances,
  type RenderedInstance,
  type RenderOptions,
} from "@/canvas/SkeletonRenderer";
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

/** Passes of the predicted style per frame (see renderModelOverlay). */
export const MODEL_DRAW_PASSES = 2;

/**
 * The SkeletonRenderer options model poses use: predicted style coloured in
 * the model's colour, no labels, and at least full pose opacity — the
 * pose-opacity setting never makes them fainter than full strength.
 */
export function modelRenderOptions(opts: ModelOverlayRenderOptions): RenderOptions {
  return {
    markerSize: opts.markerSize,
    nodeLabelSize: 12, // labels are off; required by RenderOptions
    poseOpacity: Math.max(1, opts.poseOpacity),
    edgeStyle: opts.edgeStyle ?? "Line",
    showInstances: true,
    showEdges: opts.showEdges,
    showLabels: false,
    showNonVisibleNodes: false,
    colorPredicted: true,
    showTrackScore: false,
    zoom: opts.zoom,
  };
}

/** Index of (layer, pose) in the flat list of all layers' poses, or -1. */
function flatIndex(layers: readonly ModelOverlayLayer[], layer: number, pose: number): number {
  if (!layers[layer] || pose >= layers[layer].poses.length) return -1;
  let i = 0;
  for (let l = 0; l < layer; l++) i += layers[l].poses.length;
  return i + pose;
}

/** Dashed box in `color` around a pose's placed nodes (Accept pick, selected model). */
function strokePoseBox(
  ctx: CanvasRenderingContext2D,
  pose: OverlayPose,
  color: RGB,
  opts: Pick<ModelOverlayRenderOptions, "zoom" | "toImage">
): void {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < pose.xy.length; i += 2) {
    if (!Number.isFinite(pose.xy[i]) || !Number.isFinite(pose.xy[i + 1])) continue;
    const [x, y] = opts.toImage(pose.xy[i], pose.xy[i + 1]);
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  if (x1 < x0) return;
  const pad = 6 / opts.zoom;
  ctx.save();
  ctx.strokeStyle = rgbToCSS(color);
  ctx.lineWidth = 2 / opts.zoom;
  ctx.setLineDash([5 / opts.zoom, 3 / opts.zoom]);
  ctx.strokeRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
  ctx.restore();
}

/**
 * The model pose under the pointer for hover, tested the way the canvas
 * tests project instances: a node first (marker distance), else the pose's
 * body (distance to its centre). Returns layer/pose and the node (null on
 * the body), or null.
 */
export function hoverTestModelOverlay(
  layers: readonly ModelOverlayLayer[],
  edges: readonly (readonly [number, number])[],
  x: number,
  y: number,
  nodeThreshold: number,
  bodyThreshold: number,
  toImage: (x: number, y: number) => [number, number]
): { layer: number; pose: number; node: number | null } | null {
  const rendered: RenderedInstance[] = [];
  const refs: { layer: number; pose: number }[] = [];
  layers.forEach((l, li) =>
    l.poses.forEach((p, pi) => {
      rendered.push(modelPoseToRendered(p, l.color, edges, toImage));
      refs.push({ layer: li, pose: pi });
    })
  );
  if (rendered.length === 0) return null;
  const node = hitTestNode(rendered, x, y, nodeThreshold);
  if (node) return { ...refs[node.instanceIdx], node: node.nodeIdx };
  const body = hitTestInstance(rendered, x, y, bodyThreshold);
  return body !== null ? { ...refs[body], node: null } : null;
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
    /** The model whose panel row is selected: its poses get dashed boxes. */
    selectedModelId?: string | null;
    /** The model pose under the pointer (layer/pose index; node null = body). */
    hover?: { layer: number; pose: number; node: number | null } | null;
  } = {}
): void {
  if (layers.length === 0) return;
  const rendered: RenderedInstance[] = [];
  for (const layer of layers) {
    for (const pose of layer.poses) rendered.push(modelPoseToRendered(pose, layer.color, edges, opts.toImage));
  }
  const renderOpts = modelRenderOptions(opts);
  // Predicted style, drawn twice so the thin dashed edges and outlines read
  // stronger than the project's own predictions (alpha 0.5 → 0.75) without a
  // second drawing style. Never dimmed below full strength by pose opacity.
  for (let pass = 0; pass < MODEL_DRAW_PASSES; pass++) renderInstances(ctx, rendered, renderOpts);

  // Selected model (panel row): a dashed box around each of its poses.
  if (extras.selectedModelId) {
    layers.forEach((layer) => {
      if (layer.modelId !== extras.selectedModelId) return;
      for (const pose of layer.poses) strokePoseBox(ctx, pose, layer.color, opts);
    });
  }

  // Hover: the same box + node highlight the canvas shows for a hovered prediction.
  const hov = extras.hover;
  if (hov) {
    const idx = flatIndex(layers, hov.layer, hov.pose);
    if (idx >= 0 && rendered[idx]) {
      renderHoverInstanceBBox(ctx, rendered[idx], renderOpts);
      if (hov.node !== null) renderHoveredNodeHighlight(ctx, rendered, idx, hov.node, renderOpts);
    }
  }

  // Picked for Accept: the same dashed box, one per picked pose.
  const sel = extras.selected;
  const selPose = sel ? layers[sel.layer]?.poses[sel.pose] : undefined;
  if (sel && selPose) strokePoseBox(ctx, selPose, layers[sel.layer].color, opts);

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
