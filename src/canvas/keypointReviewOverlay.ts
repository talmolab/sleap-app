/**
 * Keypoint review on the canvas: an amber ring around the node under review,
 * and, when there is one, a small teal dot where that node usually sits (the
 * typical pose fitted on the instance's other nodes), joined by a thin line.
 */
import type { RenderedInstance, RenderOptions } from "./SkeletonRenderer";
import { TYPICAL_POSE_COLOR } from "./typicalPoseGhost";

export const KEYPOINT_REVIEW_COLOR = "rgba(251, 191, 36, 0.95)";

export interface KeypointReviewMark {
  /** Index into the drawn instances (the frame's `instances`). */
  instanceIdx: number;
  node: number;
  /** Image coords of the node's typical spot, if known. */
  typical: [number, number] | null;
}

export function renderKeypointReviewMark(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  mark: KeypointReviewMark,
  opts: Pick<RenderOptions, "zoom" | "markerSize">,
): void {
  const inst = instances[mark.instanceIdx];
  if (!inst) return;
  const z = opts.zoom;
  const at = inst.nodes[mark.node];
  const placed = !!at && Number.isFinite(at.x) && Number.isFinite(at.y);
  ctx.save();
  if (mark.typical && Number.isFinite(mark.typical[0])) {
    const [tx, ty] = mark.typical;
    if (placed) {
      ctx.strokeStyle = TYPICAL_POSE_COLOR;
      ctx.lineWidth = 1.2 / z;
      ctx.setLineDash([3 / z, 3 / z]);
      ctx.beginPath();
      ctx.moveTo(at.x, at.y);
      ctx.lineTo(tx, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = TYPICAL_POSE_COLOR;
    ctx.beginPath();
    ctx.arc(tx, ty, 2.5 / z, 0, Math.PI * 2);
    ctx.fill();
  }
  if (placed) {
    const r = (opts.markerSize + 8) / z;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 4 / z;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = KEYPOINT_REVIEW_COLOR;
    ctx.lineWidth = 2.2 / z;
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
