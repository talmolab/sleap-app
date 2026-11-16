/**
 * Claude's proposed pose, drawn over the instance it would change (QC Review):
 * a ring where each moved node would go, with a thin line from where it is
 * now, the edges it would change as dashed "ghost" lines, and an × on nodes it
 * would mark not visible. Separate from SkeletonRenderer so the main renderer stays
 * as it was.
 */
import type { RenderedInstance, RenderOptions } from "./SkeletonRenderer";

/** Claude's color (warm orange), so the ghost can't be mistaken for a pose. */
export const PROPOSAL_COLOR = "#e8743b";

/** One node of a proposal: unchanged, moved to (x, y) in image coords, or hidden. */
export type GhostNode = { kind: "same" } | { kind: "move"; x: number; y: number } | { kind: "hide" };

export interface ProposalGhost {
  /** Index into the drawn instances (the frame's `instances`). */
  instanceIdx: number;
  nodes: GhostNode[];
}

type Pt = { x: number; y: number; visible: boolean };

/** The pose after the proposal: moved nodes at their new place, hidden ones not visible. */
export function ghostPose(inst: RenderedInstance, nodes: GhostNode[]): Pt[] {
  return inst.nodes.map((n, i) => {
    const g = nodes[i] ?? { kind: "same" };
    if (g.kind === "move") return { x: g.x, y: g.y, visible: true };
    if (g.kind === "hide") return { x: n.x, y: n.y, visible: false };
    return { x: n.x, y: n.y, visible: n.visible && !isNaN(n.x) };
  });
}

export function renderProposalGhosts(
  ctx: CanvasRenderingContext2D,
  instances: RenderedInstance[],
  ghosts: ProposalGhost[],
  opts: Pick<RenderOptions, "zoom" | "markerSize">,
): void {
  const z = opts.zoom;
  for (const g of ghosts) {
    const inst = instances[g.instanceIdx];
    if (!inst) continue;
    const pose = ghostPose(inst, g.nodes);
    ctx.save();
    ctx.strokeStyle = PROPOSAL_COLOR;
    ctx.fillStyle = PROPOSAL_COLOR;
    ctx.lineCap = "round";

    // Ghost edges, dashed: only those a change touches (the rest would sit
    // exactly on the pose's own edges).
    const changed = (i: number) => (g.nodes[i]?.kind ?? "same") !== "same";
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2 / z;
    ctx.setLineDash([5 / z, 4 / z]);
    for (const e of inst.edges) {
      if (!changed(e.srcIdx) && !changed(e.dstIdx)) continue;
      const a = pose[e.srcIdx];
      const b = pose[e.dstIdx];
      if (!a?.visible || !b?.visible) continue;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    // Moved nodes: a line from the current spot, then a hollow ring at the new one.
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([2 / z, 3 / z]);
    ctx.lineWidth = 1 / z;
    const r = (opts.markerSize + 2) / z;
    g.nodes.forEach((n, i) => {
      if (n.kind !== "move") return;
      const from = inst.nodes[i];
      if (from && !isNaN(from.x)) {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(n.x, n.y);
        ctx.stroke();
      }
    });
    ctx.setLineDash([]);
    ctx.lineWidth = 2 / z;
    g.nodes.forEach((n, i) => {
      if (n.kind === "move") {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        ctx.stroke();
      } else if (n.kind === "hide") {
        const at = inst.nodes[i];
        if (!at || isNaN(at.x)) return;
        const d = r * 0.8;
        ctx.beginPath();
        ctx.moveTo(at.x - d, at.y - d);
        ctx.lineTo(at.x + d, at.y + d);
        ctx.moveTo(at.x + d, at.y - d);
        ctx.lineTo(at.x - d, at.y + d);
        ctx.stroke();
      }
    });
    ctx.restore();
  }
}
