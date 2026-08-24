/**
 * Canvas glue for the visual skeleton builder.
 *
 * Turns the store's scratch `builderPositions` (index-aligned to the
 * skeleton's nodes) plus the skeleton graph into a {@link RenderedInstance},
 * so the EXISTING {@link renderInstances}/{@link hitTestNode} machinery draws
 * and hit-tests the in-progress skeleton exactly like a real labeled instance.
 *
 * The field mapping mirrors the LabeledFrame-instance → RenderedInstance
 * conversion in `VideoPlayer.tsx` (see `labeledFrame.instances.map(...)`),
 * only sourcing positions from `builderPositions` and edges from
 * `skeleton.edgeIndices`. Unplaced nodes map to `x/y = NaN` + `visible:false`
 * so `hitTestNode` (which skips NaN-coord nodes) leaves them un-clickable.
 */

import type { Skeleton } from "@talmolab/sleap-io.js";
import type { RenderedInstance, RenderedNode, RenderedEdge } from "./SkeletonRenderer";
import type { RGB } from "../lib/colorPalettes";

/** Position of a placed builder node in scene/source coords (null = unplaced). */
export type BuilderPosition = { x: number; y: number } | null;

/** Default color for the in-progress builder skeleton (Tailwind sky-400). */
const DEFAULT_BUILDER_COLOR: RGB = [56, 189, 248];

export interface BuildBuilderRenderedInstanceOptions {
  /** Override the builder skeleton color; defaults to {@link DEFAULT_BUILDER_COLOR}. */
  color?: RGB;
}

/**
 * Build a {@link RenderedInstance} for the skeleton-builder scratch buffer.
 *
 * One {@link RenderedNode} per `skeleton.nodes[i]`: a placed
 * `builderPositions[i]` yields finite `x/y` + `visible:true`; a `null` or
 * missing entry yields `x/y = NaN` + `visible:false`. Edges mirror
 * `skeleton.edgeIndices` as `{ srcIdx, dstIdx }` pairs.
 */
export function buildBuilderRenderedInstance(
  skeleton: Skeleton,
  builderPositions: BuilderPosition[],
  opts: BuildBuilderRenderedInstanceOptions = {}
): RenderedInstance {
  const nodes: RenderedNode[] = skeleton.nodes.map((node, nIdx) => {
    const pos = builderPositions[nIdx] ?? null;
    if (pos) {
      return {
        x: pos.x,
        y: pos.y,
        visible: true,
        complete: false,
        name: node.name,
      };
    }
    // Unplaced: NaN coords so hitTestNode/nodesInRect skip it.
    return {
      x: NaN,
      y: NaN,
      visible: false,
      complete: false,
      name: node.name,
    };
  });

  const edges: RenderedEdge[] = skeleton.edgeIndices.map(
    ([srcIdx, dstIdx]) => ({ srcIdx, dstIdx })
  );

  return {
    nodes,
    edges,
    color: opts.color ?? DEFAULT_BUILDER_COLOR,
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
  };
}

/**
 * Draw the live pen stroke as a dashed polyline through `points` (scene space).
 *
 * Reuses the dashed-line style of the marquee/ROI overlays in
 * SkeletonRenderer. No-op for fewer than 2 points.
 */
export function renderPenStroke(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[]
): void {
  if (points.length < 2) return;

  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
