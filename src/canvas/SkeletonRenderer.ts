/**
 * Canvas 2D skeleton overlay renderer.
 *
 * Draws skeleton instances (nodes, edges, labels, bounding boxes)
 * on top of a video frame. Matches the visual style of SLEAP's
 * Qt-based QtInstance/QtNode/QtEdge rendering.
 */

import { rgbToCSS, type RGB } from "../lib/colorPalettes";
import type { EdgeStyle } from "../types";

// Predicted instances render in a fixed color (rather than their track's
// palette color) so they read as "unconfirmed" at a glance, regardless of
// which track they belong to.
const PREDICTED_COLOR: RGB = [250, 204, 21]; // Tailwind yellow-400

// Node-name label colors, matching PyQt SLEAP's QtNodeLabel.adjustStyle():
// a label starts red ("incomplete" -- placed at a default/unconfirmed
// position) and turns green once the user explicitly confirms it ("complete").
const COMPLETE_COLOR: RGB = [80, 194, 159]; // greenish
const INCOMPLETE_COLOR: RGB = [232, 45, 32]; // redish
const MISSING_LABEL_COLOR: RGB = [128, 128, 128];

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
  zoom: 1,
};

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

  for (const instance of sorted) {
    if (!instance.visible) continue; // #2755 per-instance hide
    renderInstance(ctx, instance, {
      ...opts,
      showNonVisibleNodes: instance.showNonVisible, // #2782 per-instance occluded
    });
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

  // Draw track label on selection (always show for predicted if colorPredicted)
  if ((isSelected || (isPredicted && opts.colorPredicted)) && instance.trackName) {
    renderTrackLabel(ctx, nodes, instance.trackName, color, instance.score, opts.zoom);
  }
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
    ctx.strokeStyle = rgbToCSS(PREDICTED_COLOR);
    ctx.lineWidth = 1 / opts.zoom;
    ctx.fillStyle = rgbToCSS(PREDICTED_COLOR, 0.5);
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
  if (touchesInvisible) {
    ctx.setLineDash([4 / opts.zoom, 3 / opts.zoom]);
  }
  ctx.beginPath();
  ctx.moveTo(src.x, src.y);
  ctx.lineTo(dst.x, dst.y);
  ctx.strokeStyle = isPredicted ? rgbToCSS(PREDICTED_COLOR, alpha) : rgbToCSS(color, alpha);
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
  ctx.fillStyle = isPredicted ? rgbToCSS(PREDICTED_COLOR, alpha) : rgbToCSS(color, alpha);
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
  if (isPredicted) {
    labelColor = PREDICTED_COLOR;
    bold = false;
  } else if (!node.visible) {
    labelColor = MISSING_LABEL_COLOR;
    bold = true;
    italic = true;
  } else if (node.complete) {
    labelColor = COMPLETE_COLOR;
    bold = true;
  } else {
    labelColor = INCOMPLETE_COLOR;
    bold = false;
  }

  const fontSize = opts.nodeLabelSize / opts.zoom;
  ctx.font = `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSize}px sans-serif`;
  ctx.fillStyle = rgbToCSS(labelColor, 0.9);
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(
    node.name,
    node.x + opts.markerSize / opts.zoom + 2 / opts.zoom,
    node.y - 2 / opts.zoom
  );
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
  score?: number,
  zoom: number = 1
): void {
  const visibleNodes = nodes.filter((n) => n.visible);
  if (visibleNodes.length === 0) return;

  const minY = Math.min(...visibleNodes.map((n) => n.y));
  const centerX =
    visibleNodes.reduce((s, n) => s + n.x, 0) / visibleNodes.length;

  let text = `Track: ${trackName}`;
  if (score !== undefined) {
    text += ` (${score.toFixed(2)})`;
  }

  // Scale font size inversely with zoom so labels remain readable
  const fontSize = 10 / zoom;
  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = rgbToCSS(color, 0.8);
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(text, centerX, minY - 14 / zoom);
}

/**
 * Hit test: find the closest node to a canvas point.
 * Returns the instance index and node index, or null.
 */
export function hitTestNode(
  instances: RenderedInstance[],
  canvasX: number,
  canvasY: number,
  threshold: number = 10
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
