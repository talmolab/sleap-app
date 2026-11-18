/**
 * Label QC Review's "typical pose": the project's typical shape fitted onto the
 * selected instance, drawn as thin teal dashed edges with hollow dots, so a
 * node that sits far from where it usually is stands out. Teal, unlike the red
 * QC flags and Claude's orange proposals, since it's neither.
 */
import type { RenderedInstance, RenderOptions } from "./SkeletonRenderer";

export const TYPICAL_POSE_COLOR = "rgba(45, 212, 191, 0.95)";

export interface TypicalPoseGhost {
  /** Index into the drawn instances (the frame's `instances`). */
  instanceIdx: number;
  /** Image coords per node; NaN where the typical pose has no position. */
  points: [number, number][] | number[][];
}

export function renderTypicalPoseGhost(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  ghost: TypicalPoseGhost,
  opts: Pick<RenderOptions, "zoom" | "markerSize">,
): void {
  const inst = instances[ghost.instanceIdx];
  if (!inst) return;
  const z = opts.zoom;
  const ok = (p: number[] | undefined): p is number[] => !!p && Number.isFinite(p[0]);
  ctx.save();
  ctx.lineCap = "round";
  for (const pass of ["casing", "line"] as const) {
    ctx.strokeStyle = pass === "casing" ? "rgba(11, 14, 19, 0.7)" : TYPICAL_POSE_COLOR;
    ctx.lineWidth = (pass === "casing" ? 3.5 : 1.6) / z;
    ctx.setLineDash(pass === "casing" ? [] : [4 / z, 3 / z]);
    for (const e of inst.edges) {
      const a = ghost.points[e.srcIdx];
      const b = ghost.points[e.dstIdx];
      if (!ok(a) || !ok(b)) continue;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = TYPICAL_POSE_COLOR;
  ctx.lineWidth = 1.6 / z;
  const r = Math.max(2, opts.markerSize * 0.6) / z;
  for (const p of ghost.points) {
    if (!ok(p)) continue;
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
