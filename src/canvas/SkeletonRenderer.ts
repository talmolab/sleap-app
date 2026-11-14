/**
 * Canvas 2D skeleton overlay renderer.
 *
 * Draws skeleton instances (nodes, edges, labels, bounding boxes)
 * on top of a video frame. Matches the visual style of SLEAP's
 * Qt-based QtInstance/QtNode/QtEdge rendering.
 */

import { rgbToCSS, type RGB } from "../lib/colorPalettes";
import type { EdgeStyle } from "../types";

// Node-name label colors, matching PyQt SLEAP's QtNodeLabel.adjustStyle():
// a label starts red ("incomplete" -- placed at a default/unconfirmed
// position) and turns green once the user explicitly confirms it ("complete").
// Exported so other UI (e.g. VideoPlayer's node-hover tooltip) can color text
// to match these same canvas conventions instead of drifting out of sync.
export const COMPLETE_COLOR: RGB = [80, 194, 159]; // greenish
export const INCOMPLETE_COLOR: RGB = [232, 45, 32]; // redish
export const MISSING_LABEL_COLOR: RGB = [128, 128, 128];

// A predicted node's FILL is always flat gray, matching PyQt SLEAP's QtNode
// (`self.brush = QBrush(QColor(128, 128, 128, 128))` for predicted points) --
// its STROKE and every predicted edge instead use the same track/instance/
// palette `color` a user instance would (computed upstream via
// getInstanceColor), UNLESS colorPredicted is off, per PyQt's
// ColorManager.get_item_color: `if is_predicted and not self.color_predicted:
// return uncolored_prediction_color if isinstance(item, Node) else (128,128,128)`
// -- i.e. NODE markers fall back to this yellow, while edges/labels fall back
// to plain gray. Matches PyQt's literal `uncolored_prediction_color = (250, 250, 10)`.
export const UNCOLORED_PREDICTED_NODE_COLOR: RGB = [250, 250, 10];
const PREDICTED_FILL_COLOR: RGB = [128, 128, 128];
const PREDICTED_LABEL_COLOR: RGB = [128, 128, 128];

export interface RenderedNode {
  x: number;
  y: number;
  visible: boolean;
  complete: boolean;
  name: string;
  score?: number;
}

export interface RenderedEdge {
  srcIdx: number;
  dstIdx: number;
}

export interface RenderedInstance {
  nodes: RenderedNode[];
  edges: RenderedEdge[];
  color: RGB;
  nodeColors?: RGB[];   // Per-node colors when distinctlyColor === "node"
  edgeColors?: RGB[];   // Per-edge colors when distinctlyColor === "edge"
  isPredicted: boolean;
  isSelected: boolean;
  trackName: string | null;
  score?: number;
  /** Per-instance canvas visibility (#2755). Instance is skipped when false. */
  visible: boolean;
  /** Per-instance "show occluded nodes" (#2782), overriding the global flag. */
  showNonVisible: boolean;
}

export interface RenderOptions {
  markerSize: number;
  nodeLabelSize: number;
  edgeStyle: EdgeStyle;
  showInstances: boolean;
  showLabels: boolean;
  showEdges: boolean;
  showNonVisibleNodes: boolean;
  colorPredicted: boolean;
  /** Append the ` (0.81)` prediction score to track labels. Default off (#316). */
  showTrackScore: boolean;
  /** Opacity (0-1) of nodes and edges, on top of their own styling; labels stay opaque (#278). Default 1. */
  poseOpacity?: number;
  /**
   * When set, every OTHER instance's nodes and edges drop to
   * {@link FOCUS_DIM_OPACITY} of `poseOpacity`, so this one stands out from
   * poses overlapping it (Label QC, going to a flagged instance).
   */
  focusInstance?: RenderedInstance | null;
  zoom: number;
}

const DEFAULT_OPTIONS: RenderOptions = {
  markerSize: 4,
  nodeLabelSize: 12,
  edgeStyle: "Line",
  showInstances: true,
  showLabels: true,
  showEdges: true,
  showNonVisibleNodes: true,
  colorPredicted: false,
  showTrackScore: false,
  poseOpacity: 1,
  zoom: 1,
};

/** Pose opacity of the instances around a focused one (see `focusInstance`). */
export const FOCUS_DIM_OPACITY = 0.25;

/**
 * Render all skeleton instances onto a canvas context.
 */
export function renderInstances(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  options: Partial<RenderOptions> = {}
): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!opts.showInstances) return;

  // Sort: predicted behind user instances, selected on top
  const sorted = [...instances].sort((a, b) => {
    if (a.isSelected !== b.isSelected) return a.isSelected ? 1 : -1;
    if (a.isPredicted !== b.isPredicted) return a.isPredicted ? -1 : 1;
    return 0;
  });

  const focus = opts.focusInstance;
  for (const instance of sorted) {
    if (!instance.visible) continue; // #2755 per-instance hide
    renderInstance(ctx, instance, {
      ...opts,
      showNonVisibleNodes: instance.showNonVisible, // #2782 per-instance occluded
      ...(focus && instance !== focus
        ? { poseOpacity: (opts.poseOpacity ?? 1) * FOCUS_DIM_OPACITY }
        : {}),
    });
  }

  // Track labels drawn in a dedicated pass ON TOP of every skeleton, so a later
  // instance's nodes/edges can't overdraw an earlier label. Iterating in the same
  // sort order keeps the selected instance's label frontmost (#316). `placed`
  // collects scene-space label boxes so overlapping labels get nudged upward.
  const placed: Array<[number, number, number, number]> = [];
  for (const instance of sorted) {
    if (!instance.visible || !instance.trackName) continue;
    if (!(instance.isSelected || (instance.isPredicted && opts.colorPredicted))) continue;
    renderTrackLabel(
      ctx,
      instance.nodes,
      instance.trackName,
      instance.color,
      instance.score,
      opts,
      placed,
    );
  }
}

/**
 * Render a single skeleton instance.
 */
function renderInstance(
  ctx: CanvasRenderingContext2D,
  instance: RenderedInstance,
  opts: RenderOptions
): void {
  const { nodes, edges, color, isPredicted, isSelected } = instance;

  // Edges and nodes take the user's pose opacity; labels and the selection
  // box are drawn after the restore, so they stay readable.
  ctx.save();
  ctx.globalAlpha *= opts.poseOpacity ?? 1;

  // Draw edges first (behind nodes)
  if (opts.showEdges) {
    edges.forEach((edge, edgeIdx) => {
      const src = nodes[edge.srcIdx];
      const dst = nodes[edge.dstIdx];
      if (!src || !dst) return;
      if (!src.visible && !opts.showNonVisibleNodes) return;
      if (!dst.visible && !opts.showNonVisibleNodes) return;

      const edgeColor = instance.edgeColors?.[edgeIdx] ?? color;

      if (opts.edgeStyle === "Wedge") {
        renderWedgeEdge(ctx, src, dst, edgeColor, isPredicted, opts);
      } else {
        renderLineEdge(ctx, src, dst, edgeColor, isPredicted, opts);
      }
    });
  }

  // Draw nodes
  nodes.forEach((node, nIdx) => {
    if (!node.visible && !opts.showNonVisibleNodes) return;
    const nodeColor = instance.nodeColors?.[nIdx] ?? color;
    renderNode(ctx, node, nodeColor, isPredicted, opts);
  });
  ctx.restore();

  // Draw node labels (skip for predicted unless colorPredicted is on)
  if (opts.showLabels && (!isPredicted || opts.colorPredicted)) {
    nodes.forEach((node) => {
      if (!node.visible && !opts.showNonVisibleNodes) return;
      renderNodeLabel(ctx, node, isPredicted, opts);
    });
  }

  // Draw selection bounding box
  if (isSelected) {
    renderSelectionBox(ctx, nodes, color, opts);
  }
  // Track labels are drawn in a separate pass in renderInstances (see #316).
}

function renderNode(
  ctx: CanvasRenderingContext2D,
  node: RenderedNode,
  color: RGB,
  isPredicted: boolean,
  opts: RenderOptions
): void {
  const radius = node.visible
    ? opts.markerSize
    : opts.markerSize / 2;

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius / opts.zoom, 0, Math.PI * 2);

  if (isPredicted) {
    // Node marker stroke: track/instance color when colorPredicted is on,
    // else PyQt's uncolored_prediction_color (yellow) -- edges/labels fall
    // back to plain gray instead (see renderLineEdge/renderNodeLabel).
    const strokeColor = opts.colorPredicted ? color : UNCOLORED_PREDICTED_NODE_COLOR;
    ctx.strokeStyle = rgbToCSS(strokeColor);
    ctx.lineWidth = 1 / opts.zoom;
    ctx.fillStyle = rgbToCSS(PREDICTED_FILL_COLOR, 0.5);
    ctx.fill();
    ctx.stroke();
  } else if (node.visible) {
    ctx.strokeStyle = rgbToCSS(color);
    ctx.lineWidth = 1 / opts.zoom;
    ctx.fillStyle = rgbToCSS(color, 0.5);
    ctx.fill();
    ctx.stroke();
  } else {
    // Non-visible: hollow circle, thin border
    ctx.strokeStyle = rgbToCSS(color);
    ctx.lineWidth = 0.5 / opts.zoom;
    ctx.fillStyle = "transparent";
    ctx.stroke();
  }
}

function renderLineEdge(
  ctx: CanvasRenderingContext2D,
  src: RenderedNode,
  dst: RenderedNode,
  color: RGB,
  isPredicted: boolean,
  opts: RenderOptions
): void {
  // An edge touching a non-visible node reads as "inferred/occluded" --
  // dashed and dimmer than a fully-detected edge.
  const touchesInvisible = !src.visible || !dst.visible;
  const alpha = isPredicted
    ? touchesInvisible ? 0.25 : 0.5
    : touchesInvisible ? 0.4 : 0.8;

  ctx.save();
  // Predicted edges are dashed (on top of the existing thinner + dimmer styling)
  // so predictions read as clearly tentative next to solid user labels (#288).
  // Occluded user edges are dashed too, but predicted stays distinguishable by
  // its thinner 1px stroke. An intentional step past strict PyQt parity.
  if (touchesInvisible || isPredicted) {
    ctx.setLineDash([4 / opts.zoom, 3 / opts.zoom]);
  }
  ctx.beginPath();
  ctx.moveTo(src.x, src.y);
  ctx.lineTo(dst.x, dst.y);
  ctx.strokeStyle = rgbToCSS(color, alpha);
  ctx.lineWidth = (isPredicted ? 1 : 2) / opts.zoom;
  ctx.stroke();
  ctx.restore();
}

function renderWedgeEdge(
  ctx: CanvasRenderingContext2D,
  src: RenderedNode,
  dst: RenderedNode,
  color: RGB,
  isPredicted: boolean,
  opts: RenderOptions
): void {
  const dx = dst.x - src.x;
  const dy = dst.y - src.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;

  const nx = -dy / len;
  const ny = dx / len;

  const srcWidth = (3 / opts.zoom);
  const dstWidth = (1 / opts.zoom);

  // A wedge (filled shape) can't be dashed, so an edge touching a non-visible
  // node just renders dimmer than a fully-detected one.
  const touchesInvisible = !src.visible || !dst.visible;
  const alpha = isPredicted
    ? touchesInvisible ? 0.15 : 0.3
    : touchesInvisible ? 0.3 : 0.6;

  ctx.beginPath();
  ctx.moveTo(src.x + nx * srcWidth, src.y + ny * srcWidth);
  ctx.lineTo(dst.x + nx * dstWidth, dst.y + ny * dstWidth);
  ctx.lineTo(dst.x - nx * dstWidth, dst.y - ny * dstWidth);
  ctx.lineTo(src.x - nx * srcWidth, src.y - ny * srcWidth);
  ctx.closePath();
  ctx.fillStyle = rgbToCSS(color, alpha);
  ctx.fill();
}

function renderNodeLabel(
  ctx: CanvasRenderingContext2D,
  node: RenderedNode,
  isPredicted: boolean,
  opts: RenderOptions
): void {
  if (!node.name) return;

  // Red until the user confirms the node's position, then green -- the
  // node's "complete" state, not its track color (matches QtNodeLabel).
  let labelColor: RGB;
  let bold: boolean;
  let italic = false;
  let showMissingBg = false;
  if (isPredicted) {
    labelColor = PREDICTED_LABEL_COLOR;
    bold = false;
  } else if (!node.visible) {
    labelColor = MISSING_LABEL_COLOR;
    bold = true;
    italic = true;
    showMissingBg = true;
  } else if (node.complete) {
    labelColor = COMPLETE_COLOR;
    bold = true;
  } else {
    labelColor = INCOMPLETE_COLOR;
    bold = false;
  }

  const fontSize = opts.nodeLabelSize / opts.zoom;
  ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSize}px sans-serif`;

  const labelX = node.x + opts.markerSize / opts.zoom + 2 / opts.zoom;
  const labelY = node.y - 2 / opts.zoom;

  // A shaded background behind non-visible node labels, matching legacy
  // SLEAP's QtNodeLabel (sleap/gui/widgets/video.py) -- the dim gray text is
  // otherwise nearly invisible against grayscale/B&W footage. Solid black at
  // ~0.4 alpha, sized to the actual text (no rounded corners, matching the
  // plain fillRect legacy uses), drawn before the text so it sits behind it.
  if (showMissingBg) {
    const pad = 2 / opts.zoom;
    const textWidth = ctx.measureText(node.name).width;
    ctx.fillStyle = "rgba(0, 0, 0, 0.39)";
    ctx.fillRect(labelX - pad, labelY - fontSize - pad, textWidth + pad * 2, fontSize + pad * 2);
  }

  ctx.fillStyle = rgbToCSS(labelColor, 0.9);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(node.name, labelX, labelY);
}

function renderSelectionBox(
  ctx: CanvasRenderingContext2D,
  nodes: RenderedNode[],
  color: RGB,
  opts: RenderOptions
): void {
  const visibleNodes = nodes.filter((n) => n.visible || opts.showNonVisibleNodes);
  if (visibleNodes.length === 0) return;

  const xs = visibleNodes.map((n) => n.x);
  const ys = visibleNodes.map((n) => n.y);
  const pad = 10 / opts.zoom;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;

  ctx.setLineDash([4 / opts.zoom, 4 / opts.zoom]);
  ctx.strokeStyle = rgbToCSS(color);
  ctx.lineWidth = 1 / opts.zoom;
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.setLineDash([]);
}

function renderTrackLabel(
  ctx: CanvasRenderingContext2D,
  nodes: RenderedNode[],
  trackName: string,
  color: RGB,
  score: number | undefined,
  opts: RenderOptions,
  placed: Array<[number, number, number, number]>,
): void {
  const visibleNodes = nodes.filter((n) => n.visible);
  if (visibleNodes.length === 0) return;

  const zoom = opts.zoom;
  const minY = Math.min(...visibleNodes.map((n) => n.y));
  const centerX =
    visibleNodes.reduce((s, n) => s + n.x, 0) / visibleNodes.length;

  let text = `Track: ${trackName}`;
  if (opts.showTrackScore && score !== undefined) {
    text += ` (${score.toFixed(2)})`;
  }

  // Font follows the node-label size control (so "bigger labels" finally affects
  // these) and stays screen-constant by dividing out zoom.
  const fontSize = opts.nodeLabelSize / zoom;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";

  // Nudge upward while this label's box would overlap one already placed, so
  // clustered instances don't smear their labels together (#316 problem 2).
  const halfW = ctx.measureText(text).width / 2;
  const lineH = fontSize * 1.2;
  const gap = 2 / zoom;
  const x1 = centerX - halfW;
  const x2 = centerX + halfW;
  let y = minY - 14 / zoom;
  for (let guard = 0; guard < 24; guard++) {
    const top = y - lineH;
    const clash = placed.some(
      ([px1, pTop, px2, pBottom]) => x1 < px2 && x2 > px1 && top < pBottom && y > pTop,
    );
    if (!clash) break;
    y -= lineH + gap;
  }
  placed.push([x1, y - lineH, x2, y]);

  // Dark outline halo so the full-opacity, track-colored text stays legible on
  // any background (#316 problem 1). Halo width is screen-constant.
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, opts.nodeLabelSize * 0.18) / zoom;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
  ctx.strokeText(text, centerX, y);
  ctx.fillStyle = rgbToCSS(color);
  ctx.fillText(text, centerX, y);
}

/** Options enabling hitTestNode to also treat a node's rendered name label as part of its clickable area. */
export interface LabelHitTestOptions {
  zoom: number;
  markerSize: number;
  nodeLabelSize: number;
}

/**
 * Hit test: find the closest node to a canvas point.
 * Returns the instance index and node index, or null.
 *
 * When `labelHitTest` is given, a click landing on a node's rendered name
 * label also counts as a hit on that node -- matching PyQt SLEAP, where
 * QtNodeLabel.mousePressEvent/mouseMoveEvent/mouseReleaseEvent simply forward
 * to the QtNode marker's own handlers, so clicking either moves the same
 * point. Predicted instances aren't draggable, so their labels are excluded.
 * The label's width is approximated (no canvas context available here to
 * measure text) -- generous enough for a comfortable click target without
 * needing pixel-perfect text metrics.
 */
export function hitTestNode(
  instances: RenderedInstance[],
  canvasX: number,
  canvasY: number,
  threshold: number = 10,
  labelHitTest?: LabelHitTestOptions
): { instanceIdx: number; nodeIdx: number } | null {
  let best: { instanceIdx: number; nodeIdx: number; dist: number } | null =
    null;

  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (!inst.visible) continue; // #2755 per-instance hide
    for (let j = 0; j < inst.nodes.length; j++) {
      const node = inst.nodes[j];
      if (!node.visible && !inst.showNonVisible) continue;
      if (!node.visible && isNaN(node.x)) continue; // truly unplaced
      const dx = node.x - canvasX;
      const dy = node.y - canvasY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < threshold && (!best || dist < best.dist)) {
        best = { instanceIdx: i, nodeIdx: j, dist };
        continue;
      }
      if (labelHitTest && !inst.isPredicted && node.name) {
        const { zoom, markerSize, nodeLabelSize } = labelHitTest;
        const fontSize = nodeLabelSize / zoom;
        const labelWidth = node.name.length * fontSize * 0.6; // rough glyph-width estimate
        const lx = node.x + markerSize / zoom + 2 / zoom;
        const ly = node.y - 2 / zoom - fontSize;
        if (
          canvasX >= lx && canvasX <= lx + labelWidth &&
          canvasY >= ly && canvasY <= ly + fontSize &&
          (!best || dist < best.dist)
        ) {
          best = { instanceIdx: i, nodeIdx: j, dist };
        }
      }
    }
  }

  return best ? { instanceIdx: best.instanceIdx, nodeIdx: best.nodeIdx } : null;
}

/**
 * Hit test: find the closest instance (by centroid distance).
 */
export function hitTestInstance(
  instances: RenderedInstance[],
  canvasX: number,
  canvasY: number,
  threshold: number = 30
): number | null {
  let best: { idx: number; dist: number } | null = null;

  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    if (!inst.visible) continue; // #2755 per-instance hide
    const visible = inst.nodes.filter((n) => n.visible);
    if (visible.length === 0) continue;

    const cx = visible.reduce((s, n) => s + n.x, 0) / visible.length;
    const cy = visible.reduce((s, n) => s + n.y, 0) / visible.length;
    const dist = Math.sqrt((cx - canvasX) ** 2 + (cy - canvasY) ** 2);

    if (dist < threshold && (!best || dist < best.dist)) {
      best = { idx: i, dist };
    }
  }

  return best?.idx ?? null;
}

// --- Multi-node selection helpers ---

export function makeNodeKey(instanceIdx: number, nodeIdx: number): string {
  return `${instanceIdx}:${nodeIdx}`;
}

export function parseNodeKey(key: string): { instanceIdx: number; nodeIdx: number } {
  const [i, n] = key.split(":");
  return { instanceIdx: parseInt(i), nodeIdx: parseInt(n) };
}

/**
 * Find all visible nodes within a scene-space rectangle.
 */
export function nodesInRect(
  instances: RenderedInstance[],
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Set<string> {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const result = new Set<string>();

  for (let i = 0; i < instances.length; i++) {
    const inst = instances[i];
    if (!inst.visible) continue; // #2755 per-instance hide
    for (let j = 0; j < inst.nodes.length; j++) {
      const node = inst.nodes[j];
      if (!node.visible && !inst.showNonVisible) continue;
      if (isNaN(node.x)) continue; // truly unplaced
      if (node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY) {
        result.add(makeNodeKey(i, j));
      }
    }
  }
  return result;
}

/**
 * Render highlight rings on selected nodes.
 */
export function renderSelectedNodeHighlights(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  selectedNodes: Set<string>,
  opts: RenderOptions
): void {
  if (selectedNodes.size === 0) return;

  ctx.strokeStyle = "white";
  ctx.lineWidth = 2 / opts.zoom;
  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";

  for (const key of selectedNodes) {
    const { instanceIdx, nodeIdx } = parseNodeKey(key);
    const inst = instances[instanceIdx];
    // #2755: a hidden instance draws nothing — not even its selection rings, or
    // the white halo would leak the positions of nodes that are meant to be
    // hidden. Occluded-node visibility follows the same per-instance flag
    // (#2782) the node dots use, so rings and dots never disagree.
    if (!inst || !inst.visible) continue;
    const node = inst.nodes[nodeIdx];
    if (!node || isNaN(node.x)) continue;
    if (!node.visible && !inst.showNonVisible) continue;

    const baseRadius = node.visible ? opts.markerSize : opts.markerSize / 2;
    const radius = (baseRadius + 3) / opts.zoom;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Render a highlight ring on the hovered node (brighter/thicker than selection).
 */
export function renderHoveredNodeHighlight(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  instanceIdx: number,
  nodeIdx: number,
  opts: RenderOptions
): void {
  const node = instances[instanceIdx]?.nodes[nodeIdx];
  if (!node || isNaN(node.x)) return;

  const color = instances[instanceIdx].color;
  const baseRadius = node.visible ? opts.markerSize : opts.markerSize / 2;
  const radius = (baseRadius + 2) / opts.zoom;

  ctx.beginPath();
  ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = "white";
  ctx.lineWidth = 2.5 / opts.zoom;
  ctx.stroke();

  // Inner colored ring
  ctx.beginPath();
  ctx.arc(node.x, node.y, radius - 1.5 / opts.zoom, 0, Math.PI * 2);
  ctx.strokeStyle = rgbToCSS(color, 0.9);
  ctx.lineWidth = 1.5 / opts.zoom;
  ctx.stroke();
}

/** One instance Label QC flagged on the current frame, for {@link renderQcFlags}. */
export interface QcCanvasFlag {
  /** Index into the rendered instances (= the frame's `instances`). */
  instanceIdx: number;
  /** Node indices behind the flag, to circle. May be empty. */
  nodes: number[];
  /** Node pairs whose length (or distance) is off, to draw as a dashed line. */
  edges?: [number, number][];
  /** Joint angles that are off, as [joint, arm end, arm end]: both arms dashed, an arc at the joint. */
  angles?: [number, number, number][];
  /** Edited since the QC run: drawn faded, since it may already be fixed. */
  stale?: boolean;
}

const QC_FLAG_COLOR = "rgba(255, 45, 85, 0.95)";
/** Dark casing under the red dashes, so they stay visible on light fur and same-colored bones. */
const QC_CASING_COLOR = "rgba(11, 14, 19, 0.85)";

/** Stroke the current path twice: a solid dark casing, then red dashes on top. */
function strokeQcPath(ctx: CanvasRenderingContext2D, z: number, casing: number, width: number): void {
  ctx.setLineDash([]);
  ctx.strokeStyle = QC_CASING_COLOR;
  ctx.lineWidth = casing / z;
  ctx.stroke();
  ctx.strokeStyle = QC_FLAG_COLOR;
  ctx.lineWidth = width / z;
  ctx.setLineDash([5 / z, 4 / z]);
  ctx.stroke();
}

/**
 * Label QC overlay: a red dashed box around each flagged instance, and on it
 * whatever is off: a red dashed line along an edge whose length is off, both
 * arms of an unusual joint angle with an arc at the joint, or a red dashed
 * circle around a node. Dashed, like the web QC app's, to read as "the
 * checker's guess" rather than part of the label.
 */
export function renderQcFlags(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  flags: QcCanvasFlag[],
  opts: RenderOptions
): void {
  const z = opts.zoom;
  const placed = (n: RenderedNode | undefined): n is RenderedNode => !!n && !isNaN(n.x);
  for (const flag of flags) {
    const inst = instances[flag.instanceIdx];
    if (!inst || !inst.visible) continue;
    const visibleNodes = inst.nodes.filter((n) => n.visible && !isNaN(n.x));
    if (visibleNodes.length === 0) continue;
    const xs = visibleNodes.map((n) => n.x);
    const ys = visibleNodes.map((n) => n.y);
    const pad = (opts.markerSize + 10) / z;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const maxX = Math.max(...xs) + pad;
    const maxY = Math.max(...ys) + pad;

    ctx.save();
    ctx.globalAlpha = flag.stale ? 0.35 : 1;
    ctx.strokeStyle = QC_FLAG_COLOR;
    ctx.lineWidth = 1.5 / z;
    ctx.setLineDash([6 / z, 4 / z]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.lineCap = "round";

    for (const [a, b] of flag.edges ?? []) {
      const pa = inst.nodes[a];
      const pb = inst.nodes[b];
      if (!placed(pa) || !placed(pb)) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      strokeQcPath(ctx, z, 5, 3);
    }

    for (const [v, a, b] of flag.angles ?? []) {
      const pv = inst.nodes[v];
      const pa = inst.nodes[a];
      const pb = inst.nodes[b];
      if (!placed(pv) || !placed(pa) || !placed(pb)) continue;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pv.x, pv.y);
      ctx.lineTo(pb.x, pb.y);
      strokeQcPath(ctx, z, 5, 2.2);
      // The arc spans the angle itself (the short way round), clear of the joint's marker.
      const a0 = Math.atan2(pa.y - pv.y, pa.x - pv.x);
      const a1 = Math.atan2(pb.y - pv.y, pb.x - pv.x);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      ctx.beginPath();
      ctx.arc(pv.x, pv.y, (opts.markerSize + 9) / z, a0, a0 + d, d < 0);
      ctx.setLineDash([]);
      ctx.strokeStyle = QC_FLAG_COLOR;
      ctx.lineWidth = 1.8 / z;
      ctx.stroke();
    }

    const radius = (opts.markerSize + 6) / z;
    for (const idx of flag.nodes) {
      const node = inst.nodes[idx];
      if (!placed(node)) continue;
      // A dark casing under the red dashes keeps the ring visible on light fur.
      ctx.setLineDash([]);
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 3.5 / z;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = QC_FLAG_COLOR;
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([4 / z, 3 / z]);
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/**
 * Render a faint dashed bounding box around a hovered instance.
 */
export function renderHoverInstanceBBox(
  ctx: CanvasRenderingContext2D,
  instance: RenderedInstance,
  opts: RenderOptions
): void {
  const visibleNodes = instance.nodes.filter((n) => n.visible);
  if (visibleNodes.length === 0) return;

  const xs = visibleNodes.map((n) => n.x);
  const ys = visibleNodes.map((n) => n.y);
  const pad = 10 / opts.zoom;
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;

  ctx.save();
  ctx.setLineDash([4 / opts.zoom, 4 / opts.zoom]);
  ctx.strokeStyle = rgbToCSS(instance.color, 0.3);
  ctx.lineWidth = 1 / opts.zoom;
  ctx.fillStyle = rgbToCSS(instance.color, 0.05);
  ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
  ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  ctx.setLineDash([]);
  ctx.restore();
}

/** A square the size of `instance`'s visible-node bbox, expanded 1.5x — a
 * reasonable top-down crop-size guess when the user hasn't set one explicitly,
 * matching sleap-nn's config-picker default crop margin. */
export function instanceBBoxCropSize(instance: RenderedInstance): number {
  const visibleNodes = instance.nodes.filter((n) => n.visible && !isNaN(n.x));
  if (visibleNodes.length === 0) return 100;
  const xs = visibleNodes.map((n) => n.x);
  const ys = visibleNodes.map((n) => n.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 1.5;
}

/** Index of the node named `name` on `instance`, or `null` if it has none (a
 * differently-shaped/mismatched skeleton). */
export function findNodeIdxByName(instance: RenderedInstance, name: string): number | null {
  const idx = instance.nodes.findIndex((n) => n.name === name);
  return idx === -1 ? null : idx;
}

/**
 * Render a dashed crop-box preview for a top-down anchor, sized `cropSize`
 * (source/video pixels). `nodeIdx === null` previews the "Auto" anchor — the
 * bbox center of the instance's visible nodes — matching sleap-nn's
 * config-picker orange dashed box (and its bbox-center crosshair for "None").
 */
export function renderAnchorCropPreview(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  instanceIdx: number,
  nodeIdx: number | null,
  cropSize: number,
  opts: RenderOptions
): void {
  const instance = instances[instanceIdx];
  if (!instance) return;

  let cx: number, cy: number;
  if (nodeIdx !== null) {
    const node = instance.nodes[nodeIdx];
    if (!node || isNaN(node.x)) return;
    cx = node.x;
    cy = node.y;
  } else {
    const visibleNodes = instance.nodes.filter((n) => n.visible && !isNaN(n.x));
    if (visibleNodes.length === 0) return;
    const xs = visibleNodes.map((n) => n.x);
    const ys = visibleNodes.map((n) => n.y);
    cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  }

  const half = cropSize / 2;
  ctx.save();
  ctx.setLineDash([6 / opts.zoom, 4 / opts.zoom]);
  ctx.strokeStyle = "#f97316";
  ctx.lineWidth = 2 / opts.zoom;
  ctx.strokeRect(cx - half, cy - half, cropSize, cropSize);
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Render a marquee selection rectangle in scene space.
 */
export function renderMarqueeRect(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  zoom: number
): void {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
  ctx.fillRect(minX, minY, w, h);
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeRect(minX, minY, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

/**
 * Draw the image-features ROI crop region (solid orange, translucent fill) in
 * image-pixel space. Distinct from {@link renderMarqueeRect} so the persistent
 * generation region reads differently from an ephemeral node selection.
 */
export function renderRoiRect(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  zoom: number
): void {
  const minX = Math.min(x1, x2);
  const minY = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);

  ctx.save();
  ctx.fillStyle = "rgba(249, 115, 22, 0.12)";
  ctx.fillRect(minX, minY, w, h);
  ctx.strokeStyle = "rgba(249, 115, 22, 0.9)";
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeRect(minX, minY, w, h);
  ctx.restore();
}
