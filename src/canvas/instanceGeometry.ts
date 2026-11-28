/**
 * An instance's drawable geometry (nodes in displayed-image coords + edges),
 * taken from the instance's OWN skeleton. A project can hold several skeletons
 * (e.g. mice and 1-node pellets on one frame), so the overlay must never draw
 * an instance with the active skeleton's nodes/edges.
 */

import type { Instance, Video } from "@talmolab/sleap-io.js";
import { toImageCoords } from "@/lib/cropTransform";
import { isUnlabeledPoint } from "@/lib/slpFormat";
import type { RenderedEdge, RenderedNode } from "./SkeletonRenderer";

export function instanceGeometry(
  inst: Instance,
  video: Video | null,
): { nodes: RenderedNode[]; edges: RenderedEdge[] } {
  const skeleton = inst.skeleton;
  const nodes: RenderedNode[] = inst.points.map((point, nIdx) => {
    // Cropped videos store points in SOURCE coords; translate into the
    // displayed crop-local image space so they overlay the cropped frame.
    // Identity for uncropped videos. (cropped pkg.slp / SLP-2.3)
    // Placed unlabeled points (finite xy, labeled=false) keep their coords so
    // they render with a distinct unlabeled marker and stay interactive during
    // editing; unplaced unlabeled points (NaN xy, e.g. from disk or unmapped
    // skeleton edits) remain NaN and are skipped by the renderer.
    const hasFinite = Number.isFinite(point.xy[0]) && Number.isFinite(point.xy[1]);
    const [nx, ny] = hasFinite
      ? toImageCoords(video, point.xy[0], point.xy[1])
      : [Number.NaN, Number.NaN];
    const unlabeled = isUnlabeledPoint(point);
    return {
      x: nx,
      y: ny,
      visible: point.visible && hasFinite,
      labeled: !unlabeled,
      complete: point.complete,
      name: skeleton.nodes[nIdx]?.name ?? `node_${nIdx}`,
      score: point.score,
    };
  });
  const edges: RenderedEdge[] = skeleton.edgeIndices.map(([srcIdx, dstIdx]) => ({
    srcIdx,
    dstIdx,
  }));
  return { nodes, edges };
}
