/**
 * Active-learning placeholder pose instances.
 *
 * Phase 2 pairs every centroid with a pose instance up front
 * (`ensurePairedPoseInstances`), creating an EMPTY user instance for each
 * animal that has no keypoints yet. Until the sweep places a point on it, that
 * instance is bookkeeping, not a label — tools that judge label quality (Label
 * QC) must not report it as an "empty instance" or fit statistics to it.
 */
import type { Instance, LabeledFrame } from "@talmolab/sleap-io.js";

/** `inst` has no placed point and a centroid on `lf` pairs with it. */
export function isUnlabeledPairedPose(lf: LabeledFrame, inst: Instance): boolean {
  // Centroid check first: it's the cheap, usually-false one (no centroids at
  // all outside active-learning projects), and it spares the point reads.
  if (!lf.centroids?.some((c) => c.instance === inst)) return false;
  return !inst.points.some(
    (p) => p.visible && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]),
  );
}
