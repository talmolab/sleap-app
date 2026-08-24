/**
 * Per-node visibility stats for the top-down anchor-part picker.
 *
 * Mirrors `sleap-nn`'s config-picker (docs/configuration/config-picker/app.html):
 * for each skeleton node, what fraction of training instances have that point
 * visible (not NaN)? A well-visible, central node makes the best top-down crop
 * anchor. Computed project-wide (every video), from USER-labeled instances only
 * — predictions aren't part of the training set.
 */

import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { Labels, Skeleton } from "@/types";

export interface NodeVisibility {
  visible: number;
  total: number;
  /** 0-100, rounded. */
  pct: number;
}

export type VisibilityTier = "high" | "medium" | "low";

/** Matches sleap-nn's config-picker thresholds: >80% high, >50% medium, else low. */
export function visibilityTier(pct: number): VisibilityTier {
  if (pct > 80) return "high";
  if (pct > 50) return "medium";
  return "low";
}

/**
 * Visibility stats for every node in `skeleton`, keyed by node name, computed
 * across every user-labeled instance in `labels` (all videos). Returns an
 * empty map for a null/empty skeleton.
 */
export function computeNodeVisibility(
  labels: Labels | null,
  skeleton: Skeleton | null
): Map<string, NodeVisibility> {
  const result = new Map<string, NodeVisibility>();
  if (!skeleton) return result;

  for (const node of skeleton.nodes) {
    result.set(node.name, { visible: 0, total: 0, pct: 0 });
  }
  if (!labels) return result;

  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      if (inst instanceof PredictedInstance) continue;
      for (let i = 0; i < inst.points.length; i++) {
        const name = skeleton.nodes[i]?.name;
        if (!name) continue;
        const stat = result.get(name);
        if (!stat) continue;
        stat.total += 1;
        if (inst.points[i]?.visible) stat.visible += 1;
      }
    }
  }

  for (const stat of result.values()) {
    stat.pct = stat.total > 0 ? Math.round((stat.visible / stat.total) * 100) : 0;
  }
  return result;
}
