/**
 * Free-centroid pairing helpers (issue #212).
 *
 * A free centroid anchor is stored as a first-class {@link UserCentroid} on
 * `frame.centroids`, separate from the pose keypoints, so the pose model never
 * treats it as a keypoint. This module holds the label-mutating helpers that
 * back that flow: resolving the pose skeleton and topping up empty pose
 * instances so Phase-2 has one pose instance to label per centroid.
 */

import { Instance } from "@talmolab/sleap-io.js";
import type { Labels, Skeleton } from "@talmolab/sleap-io.js";

/** The pose skeleton to pair centroids against — the project's first skeleton. */
export function poseSkeletonOf(labels: Labels): Skeleton | null {
  return labels.skeletons[0] ?? null;
}

/**
 * Ensure every frame has at least as many pose instances as it has (finite)
 * first-class centroid annotations (`frame.centroids`), appending empty pose
 * instances (all nodes unplaced) so Phase-2 has a pose instance to label per
 * centroid. Mutates `labels`; returns the number of pose instances created.
 */
export function ensurePairedPoseInstances(
  labels: Labels,
  poseSkel: Skeleton,
): number {
  let created = 0;
  for (const lf of labels.labeledFrames) {
    const nCentroid = lf.centroids.filter(
      (c) => Number.isFinite(c.xy[0]) && Number.isFinite(c.xy[1]),
    ).length;
    let nPose = lf.instances.filter((i) => i.skeleton === poseSkel).length;
    while (nPose < nCentroid) {
      lf.instances.push(Instance.empty({ skeleton: poseSkel }));
      nPose += 1;
      created += 1;
    }
  }
  return created;
}
