/**
 * An instance's drawable geometry (nodes in displayed-image coords + edges),
 * taken from the instance's OWN skeleton. A project can hold several skeletons
 * (e.g. mice and 1-node pellets on one frame), so the overlay must never draw
 * an instance with the active skeleton's nodes/edges.
 */

import type { Instance, Video } from "@talmolab/sleap-io.js";
import { toImageCoords } from "@/lib/cropTransform";
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
    const [nx, ny] = toImageCoords(video, point.xy[0], point.xy[1]);
    return {
      x: nx,
      y: ny,
      visible: point.visible && !isNaN(point.xy[0]),
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
