/**
 * io adapter: build a {@link SkeletonAnalyzer} from a sleap-io.js Skeleton.
 *
 * The reference (github.com/alexwu-z/sleap-qc-webapp, io 0.4.0) resolved edges
 * from `skeleton.edges[].source/destination` names. Our io (0.5.13) exposes
 * `skeleton.edgeIndices` (`[srcIdx, dstIdx][]`) directly, which is what
 * labelQc.ts already uses — so we take edges from there. Declared symmetry pairs
 * come from `skeleton.symmetries[].nodes` resolved to indices via
 * `skeleton.index`, normalized ascending for determinism (the Python source's
 * intra-pair order is set-iteration-dependent; see the reference's note).
 */
import type { Skeleton } from "@/types";
import { SkeletonAnalyzer } from "./skeleton";

export function analyzerFromSkeleton(skeleton: Skeleton): SkeletonAnalyzer {
  const nNodes = skeleton.nodeNames.length;
  const edges: [number, number][] = skeleton.edgeIndices.map(([a, b]) => [a, b]);

  const symmetryPairs: [number, number][] = [];
  for (const sym of skeleton.symmetries ?? []) {
    const members = [...(sym.nodes ?? [])];
    if (members.length !== 2) continue;
    const a = skeleton.index(members[0]);
    const b = skeleton.index(members[1]);
    if (a >= 0 && b >= 0 && a !== b)
      symmetryPairs.push([Math.min(a, b), Math.max(a, b)]);
  }

  return new SkeletonAnalyzer(nNodes, edges, symmetryPairs);
}
